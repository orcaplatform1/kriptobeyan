import { Module } from '@nestjs/common';
import { TransactionAggregationService } from './transaction-aggregation.service';
import { TransactionAggregationController } from './transaction-aggregation.controller';
import { SpamFilterModule } from '../spam-filter/spam-filter.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [SpamFilterModule, NotificationsModule],
  controllers: [TransactionAggregationController],
  providers: [TransactionAggregationService],
  exports: [TransactionAggregationService],
})
export class TransactionAggregationModule {}
