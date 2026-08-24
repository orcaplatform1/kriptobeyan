import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import type { ExchangeAdapter } from './exchange-adapter.interface';
import { BinanceAdapter } from './binance.adapter';
import { BybitAdapter } from './bybit.adapter';
import { OkxAdapter } from './okx.adapter';
import { BtcturkAdapter } from './btcturk.adapter';
import { ParibuAdapter } from './paribu.adapter';
import { KrakenAdapter } from './kraken.adapter';
import { KucoinAdapter } from './kucoin.adapter';
import { CoinbaseAdapter } from './coinbase.adapter';
import { GateioAdapter } from './gateio.adapter';
import { BitgetAdapter } from './bitget.adapter';
import { HtxAdapter } from './htx.adapter';
import { MexcAdapter } from './mexc.adapter';
import { CryptocomAdapter } from './cryptocom.adapter';
import { BitexenAdapter } from './bitexen.adapter';
import { IcrypexAdapter } from './icrypex.adapter';
import { BitciAdapter } from './bitci.adapter';

@Injectable()
export class AdapterRegistryService {
  private readonly adapters: Map<ExchangeProvider, ExchangeAdapter>;

  constructor(
    binance: BinanceAdapter,
    bybit: BybitAdapter,
    okx: OkxAdapter,
    btcturk: BtcturkAdapter,
    paribu: ParibuAdapter,
    kraken: KrakenAdapter,
    kucoin: KucoinAdapter,
    coinbase: CoinbaseAdapter,
    gateio: GateioAdapter,
    bitget: BitgetAdapter,
    htx: HtxAdapter,
    mexc: MexcAdapter,
    cryptocom: CryptocomAdapter,
    bitexen: BitexenAdapter,
    icrypex: IcrypexAdapter,
    bitci: BitciAdapter,
  ) {
    this.adapters = new Map<ExchangeProvider, ExchangeAdapter>([
      [ExchangeProvider.BINANCE, binance],
      [ExchangeProvider.BYBIT, bybit],
      [ExchangeProvider.OKX, okx],
      [ExchangeProvider.BTCTURK, btcturk],
      [ExchangeProvider.PARIBU, paribu],
      [ExchangeProvider.KRAKEN, kraken],
      [ExchangeProvider.KUCOIN, kucoin],
      [ExchangeProvider.COINBASE, coinbase],
      [ExchangeProvider.GATEIO, gateio],
      [ExchangeProvider.BITGET, bitget],
      [ExchangeProvider.HTX, htx],
      [ExchangeProvider.MEXC, mexc],
      [ExchangeProvider.CRYPTOCOM, cryptocom],
      [ExchangeProvider.BITEXEN, bitexen],
      [ExchangeProvider.ICRYPEX, icrypex],
      [ExchangeProvider.BITCI, bitci],
    ]);
  }

  get(provider: ExchangeProvider): ExchangeAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`${provider} için adaptör bulunamadı`);
    }
    return adapter;
  }
}
