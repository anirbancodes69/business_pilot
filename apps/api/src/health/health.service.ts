import { Inject, Injectable } from '@nestjs/common';
import { AiEngineClient } from '../platform/ai-engine/ai-engine.client';
import { DatabaseService } from '../platform/database/database.module';

export type CheckResult = 'ok' | 'fail';
export interface ReadyReport {
  status: CheckResult;
  checks: Record<string, CheckResult>;
}

export async function runChecks(checks: Record<string, () => Promise<void>>): Promise<ReadyReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, fn]): Promise<[string, CheckResult]> => {
      try {
        await fn();
        return [name, 'ok'];
      } catch {
        return [name, 'fail']; // never expose error details (may contain hostnames or credentials)
      }
    }),
  );
  const result = Object.fromEntries(entries);
  const status = entries.every(([, r]) => r === 'ok') ? 'ok' : 'fail';
  return { status, checks: result };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AiEngineClient) private readonly ai: AiEngineClient,
  ) {}

  ready(): Promise<ReadyReport> {
    return runChecks({ postgres: () => this.db.ping(), aiEngine: () => this.ai.health() });
  }
}
