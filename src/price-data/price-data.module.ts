import { Module } from '@nestjs/common';
import { PriceDataService } from './price-data.service';
import { CoingeckoClient } from './coingecko.client';
import { TcmbClient } from './tcmb.client';

@Module({
  providers: [PriceDataService, CoingeckoClient, TcmbClient],
  exports: [PriceDataService],
})
export class PriceDataModule {}
