import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { MailModule } from './mail/mail.module';
import { SmsModule } from './sms/sms.module';
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
import { AnalyticsModule } from './analytics/analytics.module';
import { SupportModule } from './support/support.module';
import { CouponsModule } from './coupons/coupons.module';

@Module({
  imports: [
    // Genel varsayilan rate limit — login/register gibi hassas uc noktalar
    // kendi @Throttle() dekoratorleriyle bunu daha da siki override ediyor.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    ScheduleModule.forRoot(),
    // Borsa/cuzdan senkronizasyonu icin arka plan is kuyrugu (bkz.
    // ExchangeIntegrationModule SyncProcessor) — Redis bu sunucuda zaten
    // calisiyor (127.0.0.1:6379), ayri bir servis kurulmadi.
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    PrismaModule,
    CryptoModule,
    MailModule,
    SmsModule,
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
    AnalyticsModule,
    SupportModule,
    CouponsModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
