import { Module } from '@nestjs/common';
import { QueryModule } from '../query/query.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { QuestionController } from './question.controller';
import { QuestionService } from './question.service';

@Module({
  imports: [TenancyModule, QueryModule],
  controllers: [QuestionController],
  providers: [QuestionService],
})
export class QuestionModule {}
