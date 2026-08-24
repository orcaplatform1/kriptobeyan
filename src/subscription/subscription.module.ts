import { Module } from '@nestjs/common';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { PaymentService } from './payment.service';
import { SubscriptionController } from './subscription.controller';
import { AdminPlansController } from './admin-plans.controller';
import { AdminPaymentsController } from './admin-payments.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { CouponsModule } from '../coupons/coupons.module';

@Module({
  imports: [AuditLogModule, CouponsModule],
  controllers: [
    SubscriptionController,
    AdminPlansController,
    AdminPaymentsController,
  ],
  providers: [PlanService, SubscriptionService, PaymentService],
  exports: [SubscriptionService, PlanService],
})
export class SubscriptionModule {}
