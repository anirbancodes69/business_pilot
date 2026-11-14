import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
import { AiProcessingController } from '../../src/question/ai-processing.controller';
import { QuestionService } from '../../src/question/question.service';
import { createFixture, env, type Fixture } from './harness';

// ADR-0022: nothing is sent to the AI model provider for a workspace that has not agreed to it,
// and what is sent excludes fields tagged personal or sensitive.

const KEY = 'k'.repeat(40);
let f: Fixture;
let service: QuestionService;
let controller: AiProcessingController;
let sent: { authorized_view: { dimensions: { id: string }[]; measures: { id: string }[] } }[] = [];
const authz = new AuthorizationService();

const req = (tenantId: string, userId: string) =>
  ({ auth: { tenantId, userId } }) as unknown as AuthedRequest;

beforeAll(async () => {
  f = await createFixture();
  const stub = {
    answer: (b: (typeof sent)[number]) => {
      sent.push(b);
      return Promise.resolve({ status: 'answered', summary: 'ok', execution: { plan_hashes: [] } });
    },
  };
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
  controller = new AiProcessingController(f.db, new AuditService());
  const model = wholesaleDistributionTemplate();
  // The tenant tags customer names as personal data.
  const dim = model.dimensions.find((d) => d.id === 'customer.name');
  if (dim) dim.tags = ['pii'];
  await f.db.tenantTx(f.A.tenantId, async (tx) => {
    await tx
      .insertInto('core.semantic_model')
      .values({
        tenant_id: f.A.tenantId,
        version: 1,
        status: 'published',
        document: JSON.stringify(model),
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

const ask = async () =>
  service.ask({
    tenantId: f.A.tenantId,
    userId: f.A.ownerUserId,
    authz: await f.db.tenantTx(f.A.tenantId, (tx) =>
      authz.load(tx, f.A.tenantId, f.A.ownerUserId, f.A.ownerMembershipId),
    ),
    question: 'Which customers owe us the most?',
  });

describe('AI processing consent (ADR-0022)', () => {
  it('is off by default, and then nothing reaches the AI engine', async () => {
    expect((await controller.status(req(f.A.tenantId, f.A.ownerUserId))).enabled).toBe(false);
    sent = [];
    await expect(ask()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ask()).rejects.toThrow('ai_processing_disabled');
    expect(sent).toEqual([]); // not even the question left the system
  });

  it('needs an explicit acknowledgement to change, and records who changed it', async () => {
    const owner = req(f.A.tenantId, f.A.ownerUserId);
    for (const bad of [
      { enabled: true },
      { enabled: true, acknowledged: false },
      { enabled: 'yes', acknowledged: true },
      { enabled: true, acknowledged: true, tenant_id: f.B.tenantId },
    ])
      await expect(controller.change(owner, bad)).rejects.toBeInstanceOf(BadRequestException);
    const on = await controller.change(owner, { enabled: true, acknowledged: true });
    expect(on.enabled).toBe(true);
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'actor_id'])
        .where('action', 'like', 'tenant.ai_processing_%')
        .execute(),
    );
    expect(events).toEqual([{ action: 'tenant.ai_processing_enabled', actor_id: f.A.ownerUserId }]);
    // another workspace is not affected
    expect((await controller.status(req(f.B.tenantId, f.B.ownerUserId))).enabled).toBe(false);
  });

  it('once enabled, questions go through, with fields tagged personal left out of what the model sees', async () => {
    sent = [];
    await ask();
    expect(sent).toHaveLength(1);
    const dims = sent[0]?.authorized_view.dimensions.map((d) => d.id) ?? [];
    expect(dims).not.toContain('customer.name'); // tagged pii by the tenant
    expect(dims).toContain('branch.name'); // untagged fields are still offered
  });

  it('can be switched off again, and then questions stop', async () => {
    await controller.change(req(f.A.tenantId, f.A.ownerUserId), {
      enabled: false,
      acknowledged: true,
    });
    await expect(ask()).rejects.toBeInstanceOf(ForbiddenException);
    const events = await f.db.tenantTx(f.A.tenantId, (tx) =>
      tx
        .selectFrom('core.audit_event')
        .select(['action', 'occurred_at'])
        .where('action', 'like', 'tenant.ai_processing_%')
        .orderBy('occurred_at')
        .execute(),
    );
    expect(events.map((e) => e.action)).toEqual([
      'tenant.ai_processing_enabled',
      'tenant.ai_processing_disabled',
    ]);
  });
});
