import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';
import { PriceDataModule } from '../price-data/price-data.module';

@Module({
  imports: [PriceDataModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
