import { Module } from '@nestjs/common';
import { ExchangeIntegrationService } from './exchange-integration.service';
import { ExchangeIntegrationController } from './exchange-integration.controller';
import { WalletAddressService } from './wallet-address.service';
import { WalletAddressController } from './wallet-address.controller';
import { CsvImportService } from './csv-import.service';
import { CsvImportController } from './csv-import.controller';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { BinanceAdapter } from './adapters/binance.adapter';
import { BybitAdapter } from './adapters/bybit.adapter';
import { OkxAdapter } from './adapters/okx.adapter';
import { BtcturkAdapter } from './adapters/btcturk.adapter';
import { ParibuAdapter } from './adapters/paribu.adapter';
import { KrakenAdapter } from './adapters/kraken.adapter';
import { KucoinAdapter } from './adapters/kucoin.adapter';
import { CoinbaseAdapter } from './adapters/coinbase.adapter';
import { GateioAdapter } from './adapters/gateio.adapter';
import { BitgetAdapter } from './adapters/bitget.adapter';
import { HtxAdapter } from './adapters/htx.adapter';
import { MexcAdapter } from './adapters/mexc.adapter';
import { CryptocomAdapter } from './adapters/cryptocom.adapter';
import { BitexenAdapter } from './adapters/bitexen.adapter';
import { IcrypexAdapter } from './adapters/icrypex.adapter';
import { BitciAdapter } from './adapters/bitci.adapter';
import { EthereumLikeClient } from './onchain/ethereum-like.client';
import { BitcoinClient } from './onchain/bitcoin.client';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { TransactionAggregationModule } from '../transaction-aggregation/transaction-aggregation.module';

@Module({
  imports: [AuditLogModule, TransactionAggregationModule],
  controllers: [
    ExchangeIntegrationController,
    WalletAddressController,
    CsvImportController,
  ],
  providers: [
    ExchangeIntegrationService,
    WalletAddressService,
    CsvImportService,
    AdapterRegistryService,
    BinanceAdapter,
    BybitAdapter,
    OkxAdapter,
    BtcturkAdapter,
    ParibuAdapter,
    KrakenAdapter,
    KucoinAdapter,
    CoinbaseAdapter,
    GateioAdapter,
    BitgetAdapter,
    HtxAdapter,
    MexcAdapter,
    CryptocomAdapter,
    BitexenAdapter,
    IcrypexAdapter,
    BitciAdapter,
    EthereumLikeClient,
    BitcoinClient,
  ],
})
export class ExchangeIntegrationModule {}
