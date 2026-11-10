import './worker-telemetry'; // must be first
import 'reflect-metadata';
import { createServer } from 'node:http';
import { loadEnv } from './platform/config/env';
import { createDb, pingDb } from './platform/database/database';
import { runChecks } from './health/health.service';

// Worker entrypoint (BullMQ consumers arrive with the first job in a later milestone).
// Until then it only exposes liveness/readiness so Compose can supervise it.
async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env, 'app');
  const server = createServer((req, res) => {
    void (async () => {
      if (req.url === '/health/live') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      } else if (req.url === '/health/ready') {
        const report = await runChecks({ postgres: () => pingDb(db) });
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
    void db.destroy().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
