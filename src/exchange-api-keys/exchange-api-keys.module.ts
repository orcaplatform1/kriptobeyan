import { Module } from '@nestjs/common';
import { ExchangeApiKeysService } from './exchange-api-keys.service';
import { ExchangeApiKeysController } from './exchange-api-keys.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuditLogModule, AuthModule],
  controllers: [ExchangeApiKeysController],
  providers: [ExchangeApiKeysService],
})
export class ExchangeApiKeysModule {}
