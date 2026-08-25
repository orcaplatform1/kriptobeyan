import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [AuditLogModule, SubscriptionModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
