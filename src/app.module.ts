import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { CryptoModule } from './crypto/crypto.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { SecurityLogModule } from './security-log/security-log.module';
import { AuthModule } from './auth/auth.module';
import { ExchangeApiKeysModule } from './exchange-api-keys/exchange-api-keys.module';

@Module({
  imports: [
    // Genel varsayilan rate limit — login/register gibi hassas uc noktalar
    // kendi @Throttle() dekoratorleriyle bunu daha da siki override ediyor.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    PrismaModule,
    CryptoModule,
    AuditLogModule,
    SecurityLogModule,
    AuthModule,
    ExchangeApiKeysModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
