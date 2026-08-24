import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import {
  AnalyticsController,
  AdminAnalyticsController,
} from './analytics.controller';

@Module({
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
