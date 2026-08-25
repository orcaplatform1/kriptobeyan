import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AdminReportsController } from './admin-reports.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SubscriptionModule } from '../subscription/subscription.module';

@Module({
  imports: [AuditLogModule, SubscriptionModule],
  controllers: [ReportsController, AdminReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
