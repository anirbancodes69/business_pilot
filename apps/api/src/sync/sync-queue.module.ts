import { Module } from '@nestjs/common';
import { SyncQueue } from './sync-queue';

/** The producer side only, so any module can queue a sync without importing the sync engine. */
@Module({ providers: [SyncQueue], exports: [SyncQueue] })
export class SyncQueueModule {}
