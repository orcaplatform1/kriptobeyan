import { Module } from '@nestjs/common';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { PaymentService } from './payment.service';
import { SubscriptionController } from './subscription.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  controllers: [SubscriptionController, AdminPlansController],
  providers: [PlanService, SubscriptionService, PaymentService],
  exports: [SubscriptionService, PlanService],
})
export class SubscriptionModule {}
