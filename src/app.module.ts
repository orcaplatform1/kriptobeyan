import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { MailModule } from './mail/mail.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { SecurityLogModule } from './security-log/security-log.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ExchangeIntegrationModule } from './exchange-integration/exchange-integration.module';
import { TransactionAggregationModule } from './transaction-aggregation/transaction-aggregation.module';
import { PriceDataModule } from './price-data/price-data.module';
import { TaxCalculationModule } from './tax-calculation/tax-calculation.module';
import { SpamFilterModule } from './spam-filter/spam-filter.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { AccountantModule } from './accountant/accountant.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TaxLossHarvestingModule } from './tax-loss-harvesting/tax-loss-harvesting.module';
import { ReportsModule } from './reports/reports.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    // Genel varsayilan rate limit — login/register gibi hassas uc noktalar
    // kendi @Throttle() dekoratorleriyle bunu daha da siki override ediyor.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    CryptoModule,
    MailModule,
    AuditLogModule,
    SecurityLogModule,
    AuthModule,
    UserModule,
    ExchangeIntegrationModule,
    TransactionAggregationModule,
    PriceDataModule,
    TaxCalculationModule,
    SpamFilterModule,
    SubscriptionModule,
    AccountantModule,
    NotificationsModule,
    TaxLossHarvestingModule,
    ReportsModule,
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
