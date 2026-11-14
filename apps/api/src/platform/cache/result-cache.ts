import { Global, Injectable, Logger, Module, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { Env_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';
import { assertUuid } from '../database/tenant-tx';

/**
 * The exact result cache store (E6.7, docs/ai/caching.md §2). Keys always carry the tenant id, so a
 * tenant's entries can be found, counted and removed on their own. A failing store never fails a
 * request: every error is a miss. Values hold tenant data, so they are never logged.
 */
export abstract class ResultCache {
  abstract get(tenantId: string, hash: string): Promise<string | undefined>;
  abstract set(tenantId: string, hash: string, value: string, ttlSeconds: number): Promise<void>;
  /** Largest value stored, in characters. Bigger results are simply not cached. */
  readonly maxValueLength = 1_000_000;
}

export const cacheKey = (tenantId: string, hash: string): string =>
  `t:${assertUuid(tenantId, 'tenantId')}:qc:${hash}`;

@Injectable()
export class NullResultCache extends ResultCache {
  get(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  set(): Promise<void> {
    return Promise.resolve();
  }
}

/** In memory, for unit tests and a single process without Redis. */
export class MemoryResultCache extends ResultCache {
  private readonly items = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }
  get(tenantId: string, hash: string): Promise<string | undefined> {
    const k = cacheKey(tenantId, hash);
    const e = this.items.get(k);
    if (!e || e.expiresAt <= this.now()) {
      this.items.delete(k);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(e.value);
  }
  set(tenantId: string, hash: string, value: string, ttlSeconds: number): Promise<void> {
    this.items.set(cacheKey(tenantId, hash), { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }
  keys(): string[] {
    return [...this.items.keys()];
  }
}

@Injectable()
export class RedisResultCache extends ResultCache implements OnModuleDestroy {
  private readonly log = new Logger('ResultCache');
  private readonly redis: Redis;
  private warned = false;

  constructor(url: string, password?: string) {
    super();
    const u = new URL(url);
    this.redis = new Redis({
      host: u.hostname,
      port: Number(u.port || 6379),
      ...(password ? { password } : {}),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 1500,
      enableOfflineQueue: false,
    });
    // An unreachable cache must not crash the process or fill the log.
    this.redis.on('error', () => this.warnOnce());
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.log.warn('result cache is unavailable; answering without it');
  }

  async get(tenantId: string, hash: string): Promise<string | undefined> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      return (await this.redis.get(cacheKey(tenantId, hash))) ?? undefined;
    } catch {
      this.warnOnce();
      return undefined;
    }
  }

  async set(tenantId: string, hash: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.set(cacheKey(tenantId, hash), value, 'EX', ttlSeconds);
    } catch {
      this.warnOnce();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: ResultCache,
      inject: [Env_TOKEN],
      useFactory: (env: Env): ResultCache =>
        env.RESULT_CACHE_ENABLED && env.REDIS_URL
          ? new RedisResultCache(env.REDIS_URL, env.REDIS_PASSWORD)
          : new NullResultCache(),
    },
  ],
  exports: [ResultCache],
})
export class CacheModule {}
