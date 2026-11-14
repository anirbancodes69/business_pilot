import type { HttpException } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../../src/configuration/templates/wholesale-distribution';
import type { Env } from '../../src/platform/config/env';
import { RequestContextSigner } from '../../src/platform/service-auth/request-context';
import { QUESTIONS_PER_WINDOW, QuestionService } from '../../src/question/question.service';
import { UsageController } from '../../src/question/usage.controller';
import { createFixture, env, type Fixture } from './harness';

// E6.2 api side: conversations, signed request contexts and the analytical context (D-21).
// The ai-engine is a stub that records what it was sent. No model is called.

const KEY = 'k'.repeat(40);
const signer = new RequestContextSigner([KEY]);
const authz = new AuthorizationService();
let f: Fixture;
let service: QuestionService;
interface Answer {
  analytical_context: { turn?: number };
}
interface Sent {
  request_context: string;
  authorized_view: unknown;
  resolved_now: string;
  analytical_context?: { focus?: { metrics?: string[] } };
}
let sent: Sent[] = [];
let reply: () => unknown;
let failing = false;

const answered = (context?: unknown) => ({
  status: 'answered',
  summary: 'ok',
  analytical_context: context,
  execution: {
    plan_hashes: ['h1'],
    grounding: 'passed',
    model_ids: ['m-plan', 'm-explain'],
    duration_ms: 1200,
    usage: {
      planner: { calls: 1, input_tokens: 1000, output_tokens: 200 },
      explainer: { calls: 1, input_tokens: 500, output_tokens: 100 },
    },
  },
});

beforeAll(async () => {
  f = await createFixture();
  const stub = {
    answer: (body: Sent) => {
      sent.push(body);
      if (failing) return Promise.reject(new Error('ai-engine answer returned 500'));
      return Promise.resolve(reply());
    },
  };
  const e = {
    ...env(),
    REQUEST_CONTEXT_SIGNING_KEY: KEY,
    INTERNAL_SERVICE_TOKEN: 'x'.repeat(20),
  } as Env;
  service = new QuestionService(f.db, new AuditService(), stub as never, signer, e);
  await f.db.tenantTx(f.A.tenantId, async (tx) => {
    await tx
      .insertInto('core.semantic_model')
      .values({
        tenant_id: f.A.tenantId,
        version: 1,
        status: 'published',
        document: JSON.stringify(wholesaleDistributionTemplate()),
      })
      .execute();
    await tx
      .insertInto('core.access_policy')
      .values({
        tenant_id: f.A.tenantId,
        version: 1,
        status: 'active',
        document: JSON.stringify(wholesaleDistributionPolicy()),
      })
      .execute();
  });
});
afterAll(async () => {
  await f.close();
});

const ownerCtx = () =>
  f.db.tenantTx(f.A.tenantId, (tx) =>
    authz.load(tx, f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId),
  );
const ask = async (over: Record<string, unknown> = {}) =>
  service.ask({
    tenantId: f.A.tenantId,
    userId: f.A.ownerUserId,
    authz: await ownerCtx(),
    question: 'Which customers have the highest dues?',
    ...over,
  });

describe('usage metering (E6.8)', () => {
  it('records counts and names for each answered question, and nothing else', async () => {
    reply = () => answered({ semantic_model_version: 1, turn: 1 });
    const before = await count('core.ai_execution');
    await ask({ question: 'SECRET-QUESTION-TEXT' });
    expect(await count('core.ai_execution')).toBe(before + 1);
    const rows = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.ai_execution')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(1)
        .execute(),
    );
    const row = rows[0];
    expect(row).toMatchObject({
      status: 'answered',
      grounding: 'passed',
      planner_calls: 1,
      explainer_calls: 1,
      input_tokens: 1500,
      output_tokens: 300,
      duration_ms: 1200,
    });
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('rows are tenant-isolated and cannot be changed or removed', async () => {
    expect(await count('core.ai_execution', f.B.tenantId)).toBe(0);
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        sql`update core.ai_execution set status = 'x'`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) => sql`delete from core.ai_execution`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('a malformed usage report makes the whole answer invalid (502), never trusted', async () => {
    reply = () => ({
      status: 'answered',
      execution: { usage: { planner: { calls: -5, input_tokens: 'many', output_tokens: 1 } } },
    });
    await expect(ask()).rejects.toMatchObject({ status: 502 });
  });
});

describe('usage summary endpoint (E6.8)', () => {
  it('sums this workspace only, in counts', async () => {
    reply = () => answered({ semantic_model_version: 1, turn: 1 });
    await ask();
    const ctrl = new UsageController(f.db);
    const req = (tenantId: string) => ({ auth: { tenantId } }) as never;
    const a = await ctrl.summary(req(f.A.tenantId), '30');
    expect(a.questions).toBeGreaterThan(0);
    expect(a.model_calls).toBe(a.questions * 2);
    expect(a.input_tokens).toBe(a.questions * 1500);
    expect(a.by_status.answered).toBe(a.questions);
    const b = await ctrl.summary(req(f.B.tenantId), '30');
    expect(b).toMatchObject({ questions: 0, model_calls: 0, input_tokens: 0, by_status: {} });
    await expect(ctrl.summary(req(f.A.tenantId), '0')).rejects.toThrow();
  });
});

describe('questions (E6.2, api side)', () => {
  it('a tenant without a published model gets a 404 and nothing is stored', async () => {
    sent = [];
    await expect(
      service.ask({
        tenantId: f.B.tenantId,
        userId: f.B.ownerUserId,
        authz: await f.db.tenantTx(f.B.tenantId, (tx) =>
          authz.load(tx, f.B.tenantId, f.B.ownerUserId, f.B.ownerMembershipId),
        ),
        question: 'dues?',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sent).toEqual([]);
  });

  it('signs a request context bound to this user, tenant, scope and model version', async () => {
    sent = [];
    reply = () => answered({ semantic_model_version: 1, turn: 99, last_analysis_type: 'ranking' });
    const ctx = await ownerCtx();
    const r = await ask();
    const body = sent[0] as Sent;
    const claims = signer.verify(
      body.request_context,
      (body.request_context as string) && claims0(body),
    );
    expect(claims.tenant_id).toBe(f.A.tenantId);
    expect(claims.user_id).toBe(f.A.ownerUserId);
    expect(claims.authz_scope_hash).toBe(ctx.authz_scope_hash);
    expect(claims.semantic_model_version).toBe(1);
    expect(claims.conversation_id).toBe(r.conversation_id);
    // the view is the user's authorized view: no physical names, no tenant ids
    expect(JSON.stringify(body.authorized_view)).not.toMatch(/analytics\.|tenant_id/);
    expect(body.resolved_now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
    // the turn counter is the api's, whatever the model returned
    expect(r.turn).toBe(1);
    expect((r.answer as Answer).analytical_context.turn).toBe(1);
  });

  it('stores identifiers and a status, never the question or the answer', async () => {
    reply = () => answered({ semantic_model_version: 1, turn: 1 });
    await ask({ question: 'SECRET-QUESTION-TEXT about Asha Traders' });
    const rows = await f.db.tenantTx(f.A.tenantId, async (tx) => {
      const turns = await tx.selectFrom('core.conversation_turn').selectAll().execute();
      const audit = await tx
        .selectFrom('core.audit_event')
        .select(['action', 'metadata'])
        .where('action', '=', 'question.asked')
        .execute();
      return JSON.stringify({ turns, audit });
    });
    expect(rows).not.toContain('SECRET-QUESTION');
    expect(rows).not.toContain('Asha');
    expect(rows).toContain('question.asked');
  });

  it('a follow-up carries the stored context, and only its owner can continue a conversation', async () => {
    reply = () =>
      answered({
        semantic_model_version: 1,
        turn: 1,
        focus: { metrics: ['revenue'], dimensions: ['customer.name'] },
      });
    const first = await ask();
    sent = [];
    const second = await ask({ conversationId: first.conversation_id });
    expect(second.turn).toBe(2);
    expect(sent[0]?.analytical_context?.focus?.metrics).toEqual(['revenue']);

    // another user in the same tenant, and the other tenant's owner, both get a plain 404
    const viewerCtx = await f.db.tenantTx(f.A.tenantId, (tx) =>
      authz.load(tx, f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId),
    );
    sent = [];
    await expect(
      service.ask({
        tenantId: f.A.tenantId,
        userId: f.A.viewerUserId,
        authz: viewerCtx,
        question: 'dues?',
        conversationId: first.conversation_id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.ask({
        tenantId: f.B.tenantId,
        userId: f.B.ownerUserId,
        authz: await f.db.tenantTx(f.B.tenantId, (tx) =>
          authz.load(tx, f.B.tenantId, f.B.ownerUserId, f.B.ownerMembershipId),
        ),
        question: 'dues?',
        conversationId: first.conversation_id,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(sent).toEqual([]);
  });

  it('a follow-up after the user lost access to something never carries it back', async () => {
    const setRole = (key: string) =>
      f.db.tenantTx(f.A.tenantId, async (tx) => {
        const role = await tx
          .selectFrom('core.role')
          .select('id')
          .where('key', '=', key)
          .executeTakeFirstOrThrow();
        await tx
          .deleteFrom('core.membership_role')
          .where('membership_id', '=', f.A.viewerMembershipId)
          .execute();
        await tx
          .insertInto('core.membership_role')
          .values({
            tenant_id: f.A.tenantId,
            membership_id: f.A.viewerMembershipId,
            role_id: role.id,
          })
          .execute();
      });
    const asViewer = async (conversationId?: string) =>
      service.ask({
        tenantId: f.A.tenantId,
        userId: f.A.viewerUserId,
        authz: await f.db.tenantTx(f.A.tenantId, (tx) =>
          authz.load(tx, f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId),
        ),
        question: 'follow up',
        conversationId,
      });
    await setRole('finance_manager');
    reply = () =>
      answered({
        semantic_model_version: 1,
        turn: 1,
        focus: {
          metrics: ['outstanding_receivables', 'revenue'],
          dimensions: ['customer.name'],
          filters: [{ dimension: 'customer.segment', operator: 'eq', values: ['retail'] }],
        },
      });
    const first = await asViewer();
    sent = [];
    const same = await asViewer(first.conversation_id);
    expect(same.turn).toBe(2);
    expect(sent[0]?.analytical_context?.focus?.metrics).toEqual([
      'outstanding_receivables',
      'revenue',
    ]);

    await setRole('sales_manager'); // the user's access narrows: no receivables any more
    sent = [];
    await asViewer(first.conversation_id);
    expect(sent[0]?.analytical_context?.focus?.metrics).toEqual(['revenue']);
    expect(JSON.stringify(sent[0]?.authorized_view)).not.toContain('outstanding_receivables');
  });

  it('a context with unknown keys from the answer service is not stored', async () => {
    reply = () => answered({ semantic_model_version: 1, turn: 1, rows: [['Asha', 900]] });
    const r = await ask();
    const ctx = (r.answer as Answer).analytical_context;
    expect(ctx).toEqual({ semantic_model_version: 1, turn: 1 });
  });

  it('an unavailable answer service gives a 502 and stores nothing', async () => {
    const before = await count('core.conversation_turn');
    failing = true;
    await expect(ask()).rejects.toMatchObject({ status: 502 });
    failing = false;
    expect(await count('core.conversation_turn')).toBe(before);
  });

  it('turns are tenant-isolated and cannot be changed or removed by the application role', async () => {
    expect(await count('core.conversation_turn', f.B.tenantId)).toBe(0);
    expect(await count('core.conversation', f.B.tenantId)).toBe(0);
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) =>
        sql`update core.conversation_turn set status = 'x'`.execute(tx),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      f.db.tenantTx(f.A.tenantId, (tx) => sql`delete from core.conversation`.execute(tx)),
    ).rejects.toThrow(/permission denied/);
  });

  it('limits how many questions one user can ask in a window (real model calls cost money)', async () => {
    reply = () => answered();
    const viewerCtx = await f.db.tenantTx(f.A.tenantId, (tx) =>
      authz.load(tx, f.A.tenantId, f.A.viewerUserId, f.A.viewerMembershipId),
    );
    const call = () =>
      service.ask({
        tenantId: f.A.tenantId,
        userId: f.A.viewerUserId,
        authz: viewerCtx,
        question: 'dues?',
      });
    // Attempts count even when they are rejected (the viewer already made one above).
    let allowed = 0;
    let status = 0;
    for (let i = 0; i < QUESTIONS_PER_WINDOW + 2 && !status; i++) {
      try {
        await call();
        allowed++;
      } catch (e) {
        status = (e as HttpException).getStatus();
      }
    }
    expect(status).toBe(429);
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThanOrEqual(QUESTIONS_PER_WINDOW);
  });
});

function claims0(body: Sent): string {
  // The request id travels in the token itself; read it back to verify against.
  const payload = JSON.parse(
    Buffer.from(body.request_context.split('.')[0] as string, 'base64url').toString(),
  ) as { request_id: string };
  return payload.request_id;
}

async function count(
  table: 'core.conversation' | 'core.conversation_turn' | 'core.ai_execution',
  tenant = f.A.tenantId,
) {
  return f.db.tenantTx(tenant, async (tx) => {
    const r = await tx
      .selectFrom(table)
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  });
}
