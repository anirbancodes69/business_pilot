import { Module } from '@nestjs/common';
import { EventQueue } from './event-queue';
import { SyncQueue } from './sync-queue';
import { TaskQueue } from './task-queue';

/** The producer side only, so any module can queue work without importing the sync engine. */
@Module({
  providers: [SyncQueue, TaskQueue, EventQueue],
  exports: [SyncQueue, TaskQueue, EventQueue],
})
export class SyncQueueModule {}
