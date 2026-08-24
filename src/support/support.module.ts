import { Module } from '@nestjs/common';
import { SupportService } from './support.service';
import { SupportController, AdminSupportController } from './support.controller';

@Module({
  controllers: [SupportController, AdminSupportController],
  providers: [SupportService],
})
export class SupportModule {}
