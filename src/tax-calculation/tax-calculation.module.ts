import { Module } from '@nestjs/common';
import { TaxCalculationService } from './tax-calculation.service';
import { TaxCalculationController } from './tax-calculation.controller';
import { PriceDataModule } from '../price-data/price-data.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PriceDataModule, NotificationsModule],
  controllers: [TaxCalculationController],
  providers: [TaxCalculationService],
  exports: [TaxCalculationService],
})
export class TaxCalculationModule {}
