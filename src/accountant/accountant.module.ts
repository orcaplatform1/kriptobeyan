import { Module } from '@nestjs/common';
import { AccountantService } from './accountant.service';
import { AccountantController } from './accountant.controller';
import { AccountantVerificationService } from './accountant-verification.service';
import {
  AccountantVerificationController,
  AdminAccountantVerificationController,
} from './accountant-verification.controller';
import { SubscriptionModule } from '../subscription/subscription.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [SubscriptionModule, AuditLogModule, NotificationsModule],
  controllers: [
    AccountantController,
    AccountantVerificationController,
    AdminAccountantVerificationController,
  ],
  providers: [AccountantService, AccountantVerificationService],
})
export class AccountantModule {}
