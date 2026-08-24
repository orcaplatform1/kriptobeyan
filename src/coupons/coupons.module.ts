import { Module } from '@nestjs/common';
import { CouponsService } from './coupons.service';
import { CouponsController, AdminCouponsController } from './coupons.controller';

@Module({
  controllers: [CouponsController, AdminCouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class CouponsModule {}
