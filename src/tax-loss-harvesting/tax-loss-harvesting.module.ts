import { Module } from '@nestjs/common';
import { TaxLossHarvestingService } from './tax-loss-harvesting.service';
import { TaxLossHarvestingController } from './tax-loss-harvesting.controller';
import { PriceDataModule } from '../price-data/price-data.module';

@Module({
  imports: [PriceDataModule],
  controllers: [TaxLossHarvestingController],
  providers: [TaxLossHarvestingService],
})
export class TaxLossHarvestingModule {}
