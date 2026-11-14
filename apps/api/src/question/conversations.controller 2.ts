import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { DatabaseService, sql } from '../platform/database/database.module';

const uuid = (v: string): string => {
  if (!z.string().uuid().safeParse(v).success) throw new NotFoundException();
  return v;
};

export const TITLE_LENGTH = 80;
export const LIST_LIMIT = 50;

/**
 * A user's own conversations (ADR-0021): the list for the sidebar, one conversation with its
 * questions and answers as they were shown, and deletion. Everything is filtered by the caller's
 * user id; another user's conversation is a plain 404.
 */
@Controller('v1/conversations')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ConversationsController {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  @Get()
  @RequirePermission('tenant:read')
  async list(@Req() req: AuthedRequest) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const rows = await this.db.tenantTx(tenantId, (tx) =>
      sql<{ id: string; title: string | null; updated_at: Date; turns: string }>`
        SELECT c.id,
               (SELECT t.question FROM core.conversation_turn t
                 WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id
                 ORDER BY t.turn ASC LIMIT 1) AS title,
               COALESCE((SELECT max(t.created_at) FROM core.conversation_turn t
                          WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id), c.created_at) AS updated_at,
               (SELECT count(*) FROM core.conversation_turn t
                 WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id) AS turns
          FROM core.conversation c
         WHERE c.tenant_id = ${tenantId} AND c.user_id = ${userId}
           -- conversations from before the history existed have no question and nothing to show
           AND EXISTS (SELECT 1 FROM core.conversation_turn t
                        WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id AND t.question IS NOT NULL)
         ORDER BY updated_at DESC
         LIMIT ${LIST_LIMIT}`
        .execute(tx)
        .then((r) => r.rows),
    );
    return {
      conversations: rows.map((r) => ({
        id: r.id,
        title: (r.title ?? '').slice(0, TITLE_LENGTH),
        updated_at: new Date(r.updated_at).toISOString(),
        turns: Number(r.turns),
      })),
    };
  }

  @Get(':id')
  @RequirePermission('tenant:read')
  async open(@Req() req: AuthedRequest, @Param('id') id: string) {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const conversationId = uuid(id);
    return this.db.tenantTx(tenantId, async (tx) => {
      const conv = await tx
        .selectFrom('core.conversation')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', conversationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!conv) throw new NotFoundException();
      const turns = await tx
        .selectFrom('core.conversation_turn')
        .select(['turn', 'question', 'answer', 'created_at'])
        .where('tenant_id', '=', tenantId)
        .where('conversation_id', '=', conversationId)
        .orderBy('turn', 'asc')
        .execute();
      return {
        conversation_id: conv.id,
        turns: turns.map((t) => ({
          turn: t.turn,
          question: t.question,
          answer: t.answer,
          created_at: t.created_at.toISOString(),
        })),
      };
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('tenant:read')
  async remove(@Req() req: AuthedRequest, @Param('id') id: string): Promise<void> {
    const { tenantId, userId } = req.auth as NonNullable<AuthedRequest['auth']>;
    const conversationId = uuid(id);
    await this.db.tenantTx(tenantId, async (tx) => {
      const conv = await tx
        .selectFrom('core.conversation')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', conversationId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (!conv) throw new NotFoundException();
      await tx
        .deleteFrom('core.conversation_turn')
        .where('tenant_id', '=', tenantId)
        .where('conversation_id', '=', conversationId)
        .execute();
      await tx
        .deleteFrom('core.conversation')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', conversationId)
        .execute();
    });
  }
}
