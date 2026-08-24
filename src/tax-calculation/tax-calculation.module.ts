import { Module } from '@nestjs/common';
import { TaxCalculationService } from './tax-calculation.service';
import { TaxCalculationController } from './tax-calculation.controller';
import { PriceDataModule } from '../price-data/price-data.module';

@Module({
  imports: [PriceDataModule],
  controllers: [TaxCalculationController],
  providers: [TaxCalculationService],
  exports: [TaxCalculationService],
})
export class TaxCalculationModule {}
