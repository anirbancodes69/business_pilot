import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PermissionGuard, RequirePermission } from '../authorization/permissions';
import { AuthGuard, TenantGuard } from '../identity/auth.guard';
import type { AuthedRequest } from '../identity/auth.types';
import { QuestionService } from './question.service';

const body = z.strictObject({
  question: z.string().trim().min(1).max(1000),
  conversation_id: z.string().uuid().optional(),
});

@Controller('v1/questions')
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class QuestionController {
  constructor(@Inject(QuestionService) private readonly service: QuestionService) {}

  /**
   * Ask a question about the business data. Everything the answer may use is limited by the caller's
   * own authorization, loaded by the guard; nothing in the body can widen it. `tenant:read` is held by
   * every role, and data access is decided by the access policy (a viewer gets "not available").
   */
  @Post()
  @HttpCode(200)
  @RequirePermission('tenant:read')
  ask(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new UnprocessableEntityException('invalid question');
    const { tenantId, userId, authz } = req.auth as NonNullable<AuthedRequest['auth']>;
    return this.service.ask({
      tenantId,
      userId,
      authz,
      question: parsed.data.question,
      conversationId: parsed.data.conversation_id,
    });
  }
}
