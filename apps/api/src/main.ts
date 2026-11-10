import './telemetry'; // must be first: patches http before it is used
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './platform/config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
}

void bootstrap();
