import { Global, Module } from '@nestjs/common';
import { AiEngineClient } from './ai-engine.client';

@Global()
@Module({ providers: [AiEngineClient], exports: [AiEngineClient] })
export class AiEngineModule {}
