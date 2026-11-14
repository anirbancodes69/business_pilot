import { Module } from '@nestjs/common';
import { ConfigModule } from './platform/config/config.module';
import { CryptoModule } from './platform/crypto/crypto.module';
import { DatabaseModule } from './platform/database/database.module';
import { ObjectStorageModule } from './platform/object-storage/object-storage.module';
import { SyncQueueModule } from './sync/sync-queue.module';
import { SyncModule } from './sync/sync.module';
import { SystemSweeper } from './sync/system-sweeper';
import { TaskWorker } from './sync/task.worker';
import { SyncWorker } from './sync/sync.worker';

/** Worker process: the same services as the api, plus the queue consumers. No HTTP routes. */
@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    CryptoModule,
    ObjectStorageModule,
    SyncModule,
    SyncQueueModule,
  ],
  providers: [SyncWorker, TaskWorker, SystemSweeper],
})
export class WorkerModule {}
