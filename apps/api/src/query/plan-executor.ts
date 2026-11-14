import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { type AuthorizationContext, canonicalJson } from '../authorization/authorization';
import { AuthorizationService } from '../authorization/authorization.service';
import {
  type SemanticModelDocument,
  validateSemanticModel,
} from '../configuration/semantic-model.validator';
import { ResultCache } from '../platform/cache/result-cache';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { DatabaseService } from '../platform/database/database.module';
import { rawRows } from '../platform/database/tenant-tx';
import { type CompiledColumn, PlanRejected, compilePlan } from './compiler';
import type { QueryPlan } from './query-plan';

export class PlanTimeout extends Error {}
export class ContextRejected extends Error {}

export interface ResultSet {
  id: string;
  role: 'current' | 'comparison';
  columns: CompiledColumn[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  result_hash: string;
}

export interface SourceInfo {
  data_source_id: string;
  data_source_name: string;
  entity: string;
}
export interface FreshnessInfo {
  dataset_id: string;
  as_of: string;
  access_mode: 'managed_sync' | 'live_federated';
  stale: boolean;
}

export interface ExecutionResult {
  /** True when the figures came from the exact result cache (the data was read earlier). */
  cache_hit: boolean;
  sources: SourceInfo[];
  freshness: FreshnessInfo[];
  plan_hash: string;
  semantic_model_version: number;
  data_executed_at: string;
  result_sets: ResultSet[];
  truncated: boolean;
}

export const STATEMENT_TIMEOUT_MS = 10_000;

/** A cached value is parsed defensively: anything unexpected is a miss, never an error. */
function parseCached(
  text: string,
): { result_sets: ResultSet[]; data_executed_at: string } | undefined {
  try {
    const v = JSON.parse(text) as { result_sets?: ResultSet[]; data_executed_at?: string };
    return Array.isArray(v.result_sets) && typeof v.data_executed_at === 'string'
      ? { result_sets: v.result_sets, data_executed_at: v.data_executed_at }
      : undefined;
  } catch {
    return undefined;
  }
}
export const STALE_AFTER_MS = 24 * 3_600_000;
/** Part of every cache key: bump either to retire all cached results after a change in meaning. */
export const CACHE_POLICY_VERSION = 1;
export const COMPILER_VERSION = 2;

/** The plan in a canonical form, so that equivalent plans share one cache entry. */
export function normalizePlan(plan: QueryPlan): unknown {
  const { rationale: _ignored, ...rest } = plan;
  void _ignored;
  return {
    ...rest,
    measures: [...rest.measures].sort(),
    filters: (rest.filters ?? [])
      .map((f) => ({ ...f, values: [...f.values].sort() }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
  };
}

/** Plans that touch fields tagged pii or sensitive are never cached (docs/ai/caching.md, Exclusions). */
export function touchesSensitiveFields(model: SemanticModelDocument, plan: QueryPlan): boolean {
  const measureIds = new Set<string>();
  const addMeasure = (id: string | undefined): void => {
    if (!id || measureIds.has(id)) return;
    measureIds.add(id);
    const m = model.measures.find((x) => x.id === id);
    addMeasure(m?.numerator);
    addMeasure(m?.denominator);
  };
  plan.measures.forEach(addMeasure);
  const dimIds = new Set([
    ...(plan.dimensions ?? []).map((d) => d.id),
    ...(plan.filters ?? []).map((f) => f.dimension),
  ]);
  const flagged = (tags: readonly string[] | undefined): boolean =>
    (tags ?? []).some((t) => t === 'pii' || t === 'sensitive');
  return (
    [...measureIds].some((id) => flagged(model.measures.find((m) => m.id === id)?.tags)) ||
    [...dimIds].some((id) => flagged(model.dimensions.find((d) => d.id === id)?.tags))
  );
}

/** A dataset has no single id of its own (its key is source and entity), so one is derived. */
function datasetId(tenantId: string, sourceId: string, entity: string): string {
  const h = createHash('sha256').update(`${tenantId}:${sourceId}:${entity}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Executes one query plan for one user (E6.3). Authorization is reloaded from the database on every
 * call: the signed request context only says who is asking, and its scope hash is compared with the
 * freshly computed one, so a change of role or policy since the token was issued ends the request.
 * Nothing the plan or the token says can widen access.
 */
@Injectable()
export class PlanExecutor {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuthorizationService) private readonly authz: AuthorizationService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ResultCache) private readonly cache: ResultCache,
    @Inject(Env_TOKEN) private readonly env: Pick<Env, 'RESULT_CACHE_TTL_SECONDS'>,
  ) {}

  async execute(input: {
    tenantId: string;
    userId: string;
    requestId: string;
    scopeHash: string;
    modelVersion: number;
    plan: QueryPlan;
    now?: Date;
  }): Promise<ExecutionResult> {
    const { tenantId, userId, plan } = input;
    const loaded = await this.db.tenantTx(tenantId, async (tx) => {
      const membership = await tx
        .selectFrom('core.tenant_membership')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (!membership) return undefined;
      const ctx = await this.authz.load(tx, tenantId, userId, membership.id);
      const row = await tx
        .selectFrom('core.semantic_model')
        .select('document')
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .executeTakeFirst();
      return { ctx, model: row ? validateSemanticModel(row.document).document : undefined };
    });
    if (!loaded?.model) throw new ContextRejected('no active membership or published model');
    const { ctx, model } = loaded;
    if (ctx.authz_scope_hash !== input.scopeHash)
      throw new ContextRejected('authorization changed');
    if (model.version !== input.modelVersion) throw new ContextRejected('semantic model changed');

    const planHash = createHash('sha256').update(canonicalJson(plan)).digest('hex');
    try {
      const result = await this.run(ctx, model, plan, planHash, input.now ?? new Date());
      await this.record(tenantId, userId, 'query.executed', planHash, {
        request_id: input.requestId,
        measures: plan.measures,
        dimensions: (plan.dimensions ?? []).map((d) => d.id),
        row_counts: result.result_sets.map((r) => r.row_count),
        cache_hit: result.cache_hit,
      });
      return result;
    } catch (e) {
      if (e instanceof PlanRejected)
        await this.record(tenantId, userId, 'query.rejected', planHash, {
          request_id: input.requestId,
          reason: e.kind,
        });
      throw e;
    }
  }

  private async run(
    ctx: AuthorizationContext,
    model: SemanticModelDocument,
    plan: QueryPlan,
    planHash: string,
    now: Date,
  ): Promise<ExecutionResult> {
    const asOf = new Intl.DateTimeFormat('en-CA', { timeZone: model.settings.timezone }).format(
      now,
    );
    const queries = compilePlan({ plan, model, ctx, asOf });
    const entities = [...new Set(queries.flatMap((q) => q.entities))];
    const prov = await this.provenance(ctx.tenant_id, entities, now);

    // Exact result cache. Authorization has already been re-checked above: a hit never skips it. The
    // key names everything the figures depend on, so a change in any of them makes a new key.
    const cacheable =
      !prov.live && !touchesSensitiveFields(model, plan) && this.env.RESULT_CACHE_TTL_SECONDS > 0;
    const hash = createHash('sha256')
      .update(
        canonicalJson({
          policy: CACHE_POLICY_VERSION,
          compiler: COMPILER_VERSION,
          tenant: ctx.tenant_id,
          scope: ctx.authz_scope_hash,
          plan: normalizePlan(plan),
          model: model.version,
          datasets: prov.versions,
          as_of: asOf,
        }),
      )
      .digest('hex');
    if (cacheable) {
      const hit = await this.cache.get(ctx.tenant_id, hash);
      const parsed = hit ? parseCached(hit) : undefined;
      if (parsed)
        return {
          cache_hit: true,
          sources: prov.sources,
          freshness: prov.freshness,
          plan_hash: planHash,
          semantic_model_version: model.version,
          data_executed_at: parsed.data_executed_at,
          result_sets: parsed.result_sets,
          truncated: parsed.result_sets.some((r) => r.truncated),
        };
    }
    try {
      const result_sets = await this.db.tenantTx(
        ctx.tenant_id,
        async (tx) => {
          const sets: ResultSet[] = [];
          for (const query of queries) {
            const raw = await rawRows(tx, query.sql, query.params);
            const truncated = raw.length > query.limit;
            const rows = raw
              .slice(0, query.limit)
              .map((r) => query.columns.map((c) => r[c.name] ?? null));
            sets.push({
              id: `${planHash.slice(0, 12)}-${query.role}`,
              role: query.role,
              columns: query.columns,
              rows,
              row_count: rows.length,
              truncated,
              result_hash: createHash('sha256').update(canonicalJson(rows)).digest('hex'),
            });
          }
          return sets;
        },
        { readOnly: true, statementTimeoutMs: STATEMENT_TIMEOUT_MS },
      );
      const executedAt = now.toISOString();
      if (cacheable) {
        // Only a successful, validated execution is stored. Too-large results are simply not cached.
        const value = JSON.stringify({ result_sets, data_executed_at: executedAt });
        if (value.length <= this.cache.maxValueLength)
          await this.cache.set(ctx.tenant_id, hash, value, this.env.RESULT_CACHE_TTL_SECONDS);
      }
      return {
        cache_hit: false,
        sources: prov.sources,
        freshness: prov.freshness,
        plan_hash: planHash,
        semantic_model_version: model.version,
        data_executed_at: executedAt,
        result_sets,
        truncated: result_sets.some((r) => r.truncated),
      };
    } catch (e) {
      if ((e as { code?: string }).code === '57014') throw new PlanTimeout('query timed out');
      throw e;
    }
  }

  /** Which sources the entities come from and how fresh they are. Read under the tenant's own RLS. */
  private async provenance(
    tenantId: string,
    entities: string[],
    now: Date,
  ): Promise<{
    sources: SourceInfo[];
    freshness: FreshnessInfo[];
    /** `dataset_id:data_version` of every dataset read: a sync that changes data changes the key. */
    versions: string[];
    /** True when a live (federated) source is involved: such results are not cached. */
    live: boolean;
  }> {
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      tx
        .selectFrom('core.dataset as d')
        .innerJoin('core.data_source as s', (j) =>
          j.onRef('s.id', '=', 'd.data_source_id').onRef('s.tenant_id', '=', 'd.tenant_id'),
        )
        .select([
          'd.data_source_id',
          'd.canonical_entity',
          'd.status',
          'd.last_successful_sync_at',
          'd.data_version',
          's.name',
          's.access_mode',
        ])
        .where('d.tenant_id', '=', tenantId)
        .where('d.canonical_entity', 'in', entities.length ? entities : ['_none'])
        .orderBy('d.canonical_entity')
        .execute(),
    );
    return {
      versions: rows
        .map(
          (r) => `${datasetId(tenantId, r.data_source_id, r.canonical_entity)}:${r.data_version}`,
        )
        .sort(),
      live: rows.some((r) => r.access_mode === 'live_federated'),
      sources: rows.map((r) => ({
        data_source_id: r.data_source_id,
        data_source_name: r.name,
        entity: r.canonical_entity,
      })),
      freshness: rows
        .filter((r) => r.last_successful_sync_at !== null)
        .map((r) => ({
          dataset_id: datasetId(tenantId, r.data_source_id, r.canonical_entity),
          as_of: (r.last_successful_sync_at as Date).toISOString(),
          access_mode: r.access_mode,
          stale:
            r.status !== 'fresh' ||
            now.getTime() - (r.last_successful_sync_at as Date).getTime() > STALE_AFTER_MS,
        })),
    };
  }

  private record(
    tenantId: string,
    actorId: string,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    // Identifiers and counts only: never rows, filter values or the question.
    return this.db.tenantTx(tenantId, (tx) =>
      this.audit.record(tx, { tenantId, actorId, action, target, metadata }),
    );
  }
}
