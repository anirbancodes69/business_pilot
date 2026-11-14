import {
  Body,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  HttpException,
  HttpCode,
  Post,
  Inject,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { currentRequestId } from '../platform/request-id/request-id';
import {
  RequestContextError,
  RequestContextSigner,
} from '../platform/service-auth/request-context';
import { ServiceTokenGuard } from '../platform/service-auth/service-token.guard';
import { PlanRejected } from './compiler';
import { ContextRejected, PlanExecutor, PlanTimeout } from './plan-executor';
import { queryPlanSchema } from './query-plan';
import { DEFAULT_MAX_TOOL_CALLS, ToolCallBudget } from './tool-call-budget';

const body = z.strictObject({ request_context: z.string().min(1), plan: z.unknown() });

/** Internal tool endpoint for ai-engine (contracts/ai/README.md). Never routed publicly. */
@Controller('internal/v1/tools')
@UseGuards(ServiceTokenGuard)
export class InternalToolsController {
  private readonly budget = new ToolCallBudget();

  constructor(
    @Inject(PlanExecutor) private readonly executor: PlanExecutor,
    @Inject(RequestContextSigner) private readonly signer: RequestContextSigner,
  ) {}

  @Post('execute-plan')
  @HttpCode(200)
  async executePlan(@Body() raw: unknown) {
    const parsed = body.safeParse(raw);
    if (!parsed.success) throw new UnprocessableEntityException('invalid request');
    let claims;
    try {
      claims = this.signer.verify(parsed.data.request_context, currentRequestId() ?? '');
    } catch (e) {
      if (e instanceof RequestContextError) throw new UnauthorizedException();
      throw e;
    }
    // The limit comes from the signed context, never from the request body or the model.
    if (
      !this.budget.take(
        claims.request_id,
        claims.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS,
        Date.parse(claims.expires_at),
      )
    )
      throw new HttpException('tool call limit reached', 429);
    const plan = queryPlanSchema.safeParse(parsed.data.plan);
    if (!plan.success) throw new UnprocessableEntityException('invalid plan');
    try {
      const r = await this.executor.execute({
        tenantId: claims.tenant_id,
        userId: claims.user_id,
        requestId: claims.request_id,
        scopeHash: claims.authz_scope_hash,
        modelVersion: claims.semantic_model_version,
        plan: plan.data,
      });
      return r;
    } catch (e: unknown) {
      if (e instanceof ContextRejected) throw new ForbiddenException(e.message);
      if (e instanceof PlanRejected)
        throw e.kind === 'forbidden'
          ? new ForbiddenException(e.message)
          : new UnprocessableEntityException(e.message);
      if (e instanceof PlanTimeout) throw new GatewayTimeoutException();
      throw e;
    }
  }
}
