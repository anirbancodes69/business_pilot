import { Module } from '@nestjs/common';
import { QueryModule } from '../query/query.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AiProcessingController } from './ai-processing.controller';
import { ConversationsController } from './conversations.controller';
import { QuestionController } from './question.controller';
import { QuestionService } from './question.service';
import { UsageController } from './usage.controller';

@Module({
  imports: [TenancyModule, QueryModule],
  controllers: [
    QuestionController,
    ConversationsController,
    UsageController,
    AiProcessingController,
  ],
  providers: [QuestionService],
})
export class QuestionModule {}
