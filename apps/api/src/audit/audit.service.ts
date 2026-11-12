import { Injectable } from '@nestjs/common';
import type { Tx } from '../platform/database/tenant-tx';

export interface AuditInput {
  tenantId: string;
  actorId: string | null;
  action: string;
  target?: string;
  /** Identifiers and small facts only. Never credentials, tokens, result rows or prompt text. */
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  /** Written in the caller's transaction, so the event commits or rolls back with the change. */
  async record(tx: Tx, input: AuditInput): Promise<void> {
    await tx
      .insertInto('core.audit_event')
      .values({
        tenant_id: input.tenantId,
        actor_id: input.actorId,
        action: input.action,
        target: input.target ?? null,
        metadata: JSON.stringify(input.metadata ?? {}),
      })
      .execute();
  }
}
