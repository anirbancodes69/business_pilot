import { NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import { AuthorizationService } from '../../src/authorization/authorization.service';
import {
  wholesaleDistributionPolicy,
  wholesaleDistributionTemplate,
} from '../../src/configuration/templates/wholesale-distribution';
import type { AuthedRequest } from '../../src/identity/auth.types';
import type { Env } from '../../src/platform/config/env';
import { RequestContextSigner } from '../../src/platform/service-auth/request-context';
import {
  ConversationsController,
  LIST_LIMIT,
  TITLE_LENGTH,
} from '../../src/question/conversations.controller';
import { QuestionService } from '../../src/question/question.service';
import { createFixture, env, type Fixture } from './harness';

// ADR-0021: a user's conversation history. Private to the user, tenant-isolated, deletable and kept
// for a retention period.

const KEY = 'k'.repeat(40);
let f: Fixture;
let service: QuestionService;
let controller: ConversationsController;
const authz = new AuthorizationService();
let reply: () => unknown;

const answerOf = (summary: string) => ({
  status: 'answered',
  summary,
  tables: [{ result_set_id: 'r', title: 'Current period', columns: [], rows: [] }],
  analytical_context: { semantic_model_version: 1, turn: 1 },
  execution: { plan_hashes: ['h'] },
});

const req = (tenantId: string, userId: string) =>
  ({ auth: { tenantId, userId } }) as unknown as AuthedRequest;

async function ask(who: 'owner' | 'viewer', question: string, conversationId?: string, now?: Date) {
  const [userId, membershipId] =
    who === 'owner'
      ? [f.A.ownerUserId, f.A.ownerMembershipId]
      : [f.A.viewerUserId, f.A.viewerMembershipId];
  const ctx = await f.db.tenantTx(f.A.tenantId, (tx) =>
    authz.load(tx, f.A.tenantId, userId, membershipId),
  );
  return service.ask({ tenantId: f.A.tenantId, userId, authz: ctx, question, conversationId, now });
}

beforeAll(async () => {
  f = await createFixture();
  const stub = { answer: () => Promise.resolve(reply()) };
  const e = {
    ...env(),
    REQUEST_CONTEXT_SIGNING_KEY: KEY,
    INTERNAL_SERVICE_TOKEN: 'x'.repeat(20),
    CONVERSATION_RETENTION_DAYS: 90,
  } as Env;
  service = new QuestionService(
    f.db,
    new AuditService(),
    stub as never,
    new RequestContextSigner([KEY]),
    e,
  );
  controller = new ConversationsController(f.db);
  await f.db.tenantTx(f.A.tenantId, (tx) =>
    tx
      .updateTable('core.tenant')
      .set({ ai_processing_enabled: true })
      .where('id', '=', f.A.tenantId)
      .execute(),
  );
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

describe('conversation history (ADR-0021)', () => {
  it('lists a user’s conversations, newest first, titled by the first question', async () => {
    reply = () => answerOf('first');
    const a = await ask('owner', 'Which customers owe us the most?');
    await ask('owner', 'And for last quarter?', a.conversation_id);
    reply = () => answerOf('second');
    const b = await ask('owner', 'x'.repeat(200));
    const { conversations } = await controller.list(req(f.A.tenantId, f.A.ownerUserId));
    expect(conversations.map((c) => c.id)).toEqual([b.conversation_id, a.conversation_id]);
    expect(conversations[1]).toMatchObject({ title: 'Which customers owe us the most?', turns: 2 });
    expect(conversations[0]?.title).toHaveLength(TITLE_LENGTH);
    expect(conversations.length).toBeLessThanOrEqual(LIST_LIMIT);
  });

  it('does not list conversations from before the history existed (nothing to show)', async () => {
    reply = () => answerOf('x');
    const a = await ask('owner', 'A conversation that will lose its question');
    await f.owner.transaction().execute(async (tx) => {
      await sql`select set_config('app.tenant_id', ${f.A.tenantId}, true)`.execute(tx);
      await sql`update core.conversation_turn set question = null, answer = null
                where conversation_id = ${a.conversation_id}`.execute(tx);
    });
    const ids = (await controller.list(req(f.A.tenantId, f.A.ownerUserId))).conversations.map(
      (c) => c.id,
    );
    expect(ids).not.toContain(a.conversation_id);
  });

  it('opens a conversation with its questions and answers as they were shown', async () => {
    reply = () => answerOf('The answer shown at the time');
    const a = await ask('owner', 'A question to reopen');
    const open = await controller.open(req(f.A.tenantId, f.A.ownerUserId), a.conversation_id);
    expect(open.turns).toHaveLength(1);
    expect(open.turns[0]).toMatchObject({ turn: 1, question: 'A question to reopen' });
    expect((open.turns[0]?.answer as { summary: string }).summary).toBe(
      'The answer shown at the time',
    );
    // the stored context is the api's own validated one
    expect(
      (open.turns[0]?.answer as { analytical_context: { turn: number } }).analytical_context.turn,
    ).toBe(1);
  });

  it('is private: another user in the tenant, and another tenant, see nothing and get a plain 404', async () => {
    reply = () => answerOf('private');
    const a = await ask('owner', 'Private question');
    const viewer = req(f.A.tenantId, f.A.viewerUserId);
    expect((await controller.list(viewer)).conversations).toEqual([]);
    await expect(controller.open(viewer, a.conversation_id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.remove(viewer, a.conversation_id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    const other = req(f.B.tenantId, f.B.ownerUserId);
    expect((await controller.list(other)).conversations).toEqual([]);
    await expect(controller.open(other, a.conversation_id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.open(viewer, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets the user delete a conversation, and only that one', async () => {
    reply = () => answerOf('x');
    const keep = await ask('owner', 'Keep this');
    const drop = await ask('owner', 'Delete this');
    await controller.remove(req(f.A.tenantId, f.A.ownerUserId), drop.conversation_id);
    const ids = (await controller.list(req(f.A.tenantId, f.A.ownerUserId))).conversations.map(
      (c) => c.id,
    );
    expect(ids).toContain(keep.conversation_id);
    expect(ids).not.toContain(drop.conversation_id);
    await expect(
      controller.open(req(f.A.tenantId, f.A.ownerUserId), drop.conversation_id),
    ).rejects.toBeInstanceOf(NotFoundException);
    // usage metering outlives the deleted conversation
    const metered = await f.db.tenantTx(f.A.tenantId, (tx) =>
      sql<{
        n: string;
      }>`select count(*)::text n from core.ai_execution where conversation_id = ${drop.conversation_id}`.execute(
        tx,
      ),
    );
    expect(Number(metered.rows[0]?.n)).toBe(1);
  });

  it('removes a user’s conversations after the retention period, when they are next active', async () => {
    reply = () => answerOf('x');
    const old = await ask('viewer', 'An old question');
    // The application role cannot edit turns, so age them with the owner role (still under RLS).
    await f.owner.transaction().execute(async (tx) => {
      await sql`select set_config('app.tenant_id', ${f.A.tenantId}, true)`.execute(tx);
      await sql`update core.conversation_turn set created_at = now() - interval '120 days'
                where conversation_id = ${old.conversation_id}`.execute(tx);
    });
    await ask('viewer', 'A fresh question today');
    const list = (await controller.list(req(f.A.tenantId, f.A.viewerUserId))).conversations;
    expect(list.map((c) => c.id)).not.toContain(old.conversation_id);
    expect(list.map((c) => c.title)).toContain('A fresh question today');
  });

  it('an answer that is too large is not kept, but the conversation is', async () => {
    reply = () => ({ ...answerOf('big'), padding: 'p'.repeat(900_000) });
    const a = await ask('owner', 'A huge answer');
    const open = await controller.open(req(f.A.tenantId, f.A.ownerUserId), a.conversation_id);
    expect(open.turns[0]).toMatchObject({ question: 'A huge answer', answer: null });
  });
});
