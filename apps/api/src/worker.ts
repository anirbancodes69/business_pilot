import './worker-telemetry'; // must be first
import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './platform/config/env';
import { createDb, pingDb } from './platform/database/database';
import { runChecks } from './health/health.service';
import { SyncQueue } from './sync/sync-queue';
import { WorkerModule } from './worker.module';

// Worker entrypoint: BullMQ consumers (the sync engine) plus a health port for Compose.
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  const db = createDb(env, 'app');
  const queue = app.get(SyncQueue);
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/health/live') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      } else if (req.url === '/health/ready') {
        const report = await runChecks({
          postgres: () => pingDb(db),
          ...(env.REDIS_URL ? { redis: () => queue.ping() } : {}),
        });
        res
          .writeHead(report.status === 'ok' ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify(report));
      } else {
        res.writeHead(404).end();
      }
    })();
  });
  server.listen(env.WORKER_HEALTH_PORT, '0.0.0.0');
  const shutdown = (): void => {
    server.close();
    void app
      .close()
      .then(() => db.destroy())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
