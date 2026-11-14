import { randomUUID } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import type { AuthorizationContext } from '../authorization/authorization';
import { buildAuthorizedView } from '../configuration/authorized-view';
import { validateSemanticModel } from '../configuration/semantic-model.validator';
import { Env_TOKEN } from '../platform/config/config.module';
import type { Env } from '../platform/config/env';
import { DatabaseService } from '../platform/database/database.module';
import { AiEngineClient } from '../platform/ai-engine/ai-engine.client';
import { RequestContextSigner } from '../platform/service-auth/request-context';
import {
  type AnalyticalContext,
  analyticalContextSchema,
  revalidateContext,
} from './analytical-context';

const STATUSES = [
  'answered',
  'answered_facts_only',
  'clarification_needed',
  'not_authorized',
  'out_of_scope',
  'failed',
] as const;

// Only what the api needs from the answer. The rest is passed on to the caller untouched.
const usageEntry = z.object({
  calls: z.number().int().min(0).max(20),
  input_tokens: z.number().int().min(0).max(10_000_000),
  output_tokens: z.number().int().min(0).max(10_000_000),
});
const answerShape = z.looseObject({
  status: z.enum(STATUSES),
  analytical_context: z.unknown().optional(),
  execution: z
    .looseObject({
      plan_hashes: z.array(z.string()).max(20).optional(),
      grounding: z.string().max(40).optional(),
      model_ids: z.array(z.string().max(100)).max(10).optional(),
      duration_ms: z.number().int().min(0).max(3_600_000).optional(),
      usage: z.object({ planner: usageEntry, explainer: usageEntry }).optional(),
    })
    .optional(),
});

export const QUESTIONS_PER_WINDOW = 20;
export const WINDOW_MS = 10 * 60_000;

/** Local time of a zone with its UTC offset, e.g. 2026-11-15T10:00:00+05:30. */
export function nowInZone(timeZone: string, now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

@Injectable()
export class QuestionService {
  // Real model calls cost money (ADR-0019): a small per-user limit, per process. Not a substitute
  // for the real rate limiting that is still open in CURRENT.md.
  private readonly recent = new Map<string, number[]>();

  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AiEngineClient) private readonly ai: AiEngineClient,
    @Inject(RequestContextSigner) private readonly signer: RequestContextSigner,
    @Inject(Env_TOKEN) private readonly env: Env,
  ) {}

  private throttle(tenantId: string, userId: string, now: number): void {
    const key = `${tenantId}:${userId}`;
    const fresh = (this.recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (fresh.length >= QUESTIONS_PER_WINDOW)
      throw new HttpException('too many questions, try again shortly', 429);
    this.recent.set(key, [...fresh, now]);
  }

  async ask(input: {
    tenantId: string;
    userId: string;
    authz: AuthorizationContext;
    question: string;
    conversationId?: string;
    now?: Date;
  }) {
    const { tenantId, userId, authz } = input;
    if (!this.env.REQUEST_CONTEXT_SIGNING_KEY || !this.env.INTERNAL_SERVICE_TOKEN)
      throw new ServiceUnavailableException('question answering is not configured');
    const now = input.now ?? new Date();
    this.throttle(tenantId, userId, now.getTime());

    const loaded = await this.db.tenantTx(tenantId, async (tx) => {
      const row = await tx
        .selectFrom('core.semantic_model')
        .select('document')
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'published')
        .executeTakeFirst();
      const model = row ? validateSemanticModel(row.document).document : undefined;
      if (!model) return undefined;
      let previous: { turn: number; context: unknown } | undefined;
      if (input.conversationId) {
        // A conversation belongs to its user. Anyone else gets the same answer as for a missing id.
        const conv = await tx
          .selectFrom('core.conversation')
          .select('id')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', input.conversationId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        if (!conv) throw new NotFoundException();
        const turn = await tx
          .selectFrom('core.conversation_turn')
          .select(['turn', 'analytical_context'])
          .where('tenant_id', '=', tenantId)
          .where('conversation_id', '=', conv.id)
          .orderBy('turn', 'desc')
          .executeTakeFirst();
        if (turn) previous = { turn: turn.turn, context: turn.analytical_context };
      }
      return { model, previous };
    });
    if (!loaded) throw new NotFoundException('no published semantic model');
    const { model, previous } = loaded;

    const view = buildAuthorizedView(model, authz);
    const { context: carried } = previous
      ? revalidateContext(previous.context, view)
      : { context: undefined };
    const conversationId = input.conversationId ?? randomUUID();
    const requestId = randomUUID();
    const token = this.signer.issue({
      request_id: requestId,
      tenant_id: tenantId,
      user_id: userId,
      conversation_id: conversationId,
      authz_scope_hash: authz.authz_scope_hash,
      semantic_model_version: model.version,
      max_tool_calls: 6,
    });

    let raw: unknown;
    try {
      raw = await this.ai.answer(
        {
          request_context: token,
          question: input.question,
          analytical_context: carried,
          authorized_view: view,
          resolved_now: nowInZone(model.settings.timezone, now),
          locale: 'en-IN',
        },
        requestId,
      );
    } catch {
      throw new HttpException('the answer service is unavailable', 502);
    }
    const answer = answerShape.safeParse(raw);
    if (!answer.success)
      throw new HttpException('the answer service returned an invalid answer', 502);

    // The turn counter is ours, not the model's. The returned context is validated before it is kept.
    const turnNumber = (previous?.turn ?? 0) + 1;
    const returned = analyticalContextSchema.safeParse(answer.data.analytical_context);
    const stored: AnalyticalContext = returned.success
      ? { ...returned.data, semantic_model_version: model.version, turn: turnNumber }
      : { semantic_model_version: model.version, turn: turnNumber };
    await this.db.tenantTx(tenantId, async (tx) => {
      if (!input.conversationId)
        await tx
          .insertInto('core.conversation')
          .values({ tenant_id: tenantId, id: conversationId, user_id: userId })
          .execute();
      await tx
        .insertInto('core.conversation_turn')
        .values({
          tenant_id: tenantId,
          conversation_id: conversationId,
          turn: turnNumber,
          analytical_context: JSON.stringify(stored),
          status: answer.data.status,
          plan_hashes: JSON.stringify(answer.data.execution?.plan_hashes ?? []),
        })
        .execute();
      const exec = answer.data.execution;
      await tx
        .insertInto('core.ai_execution')
        .values({
          tenant_id: tenantId,
          user_id: userId,
          conversation_id: conversationId,
          turn: turnNumber,
          request_id: requestId,
          status: answer.data.status,
          grounding: exec?.grounding ?? null,
          planner_calls: exec?.usage?.planner.calls ?? 0,
          explainer_calls: exec?.usage?.explainer.calls ?? 0,
          input_tokens:
            (exec?.usage?.planner.input_tokens ?? 0) + (exec?.usage?.explainer.input_tokens ?? 0),
          output_tokens:
            (exec?.usage?.planner.output_tokens ?? 0) + (exec?.usage?.explainer.output_tokens ?? 0),
          model_ids: JSON.stringify(exec?.model_ids ?? []),
          duration_ms: exec?.duration_ms ?? null,
        })
        .execute();
      // Identifiers and a status only. Never the question, the answer or any figure.
      await this.audit.record(tx, {
        tenantId,
        actorId: userId,
        action: 'question.asked',
        target: conversationId,
        metadata: { turn: turnNumber, status: answer.data.status, request_id: requestId },
      });
    });
    return {
      conversation_id: conversationId,
      turn: turnNumber,
      answer: { ...(raw as object), analytical_context: stored },
    };
  }
}
