import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  ApiPermissionLevel,
  ExchangeProvider,
  TransactionType,
} from '../../../generated/prisma/client';
import type {
  ExchangeAdapter,
  ExchangeCredentials,
  NormalizedExchangeTransaction,
} from './exchange-adapter.interface';

const REST_BASE = 'https://api.binance.com';
// Kullanicinin elinde ne varsa onunla eslesen ciftleri deneriz — Binance'in
// "tum spot islemleri" diye tek bir uc noktasi yok (bkz. arayuz yorumu).
const COMMON_QUOTES = ['USDT', 'TRY', 'BUSD', 'BTC', 'FDUSD'];

interface BinanceDeposit {
  txId?: string;
  id: string;
  coin: string;
  amount: string;
  insertTime: number;
}

interface BinanceWithdrawal {
  id: string;
  coin: string;
  amount: string;
  transactionFee?: string;
  applyTime: string;
}

interface BinanceTrade {
  id: string;
  isBuyer: boolean;
  qty: string;
  price: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

/**
 * NOT: Bu adaptor Binance'in resmi REST API dokumantasyonuna gore yazildi
 * ancak gercek, kimlikli bir hesaba karsi TEST EDILMEDI (bu ortamda test
 * API key'i yok). Uretime almadan once gercek bir hesapla dogrulanmali.
 */
@Injectable()
export class BinanceAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.BINANCE;
  private readonly logger = new Logger(BinanceAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      const res = await this.signedGet<{
        enableReading: boolean;
        enableSpotAndMarginTrading: boolean;
        enableWithdrawals: boolean;
      }>('/sapi/v1/account/apiRestrictions', {}, credentials);

      if (res.enableWithdrawals) return ApiPermissionLevel.WITHDRAW;
      if (res.enableSpotAndMarginTrading) return ApiPermissionLevel.TRADE;
      if (res.enableReading) return ApiPermissionLevel.READ_ONLY;
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `Binance izin dogrulama basarisiz: ${(err as Error).message}`,
      );
      return ApiPermissionLevel.UNKNOWN;
    }
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const startTime = since?.getTime();
    const results: NormalizedExchangeTransaction[] = [];

    results.push(...(await this.fetchDeposits(credentials, startTime)));
    results.push(...(await this.fetchWithdrawals(credentials, startTime)));
    results.push(...(await this.fetchTrades(credentials, startTime)));

    return results;
  }

  private async fetchDeposits(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const rows = await this.signedGet<BinanceDeposit[]>(
      '/sapi/v1/capital/deposit/hisrec',
      startTime ? { startTime } : {},
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.txId ?? r.id}`,
      type: TransactionType.DEPOSIT,
      asset: r.coin,
      quantity: String(r.amount),
      timestamp: new Date(r.insertTime),
      raw: r,
    }));
  }

  private async fetchWithdrawals(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const rows = await this.signedGet<BinanceWithdrawal[]>(
      '/sapi/v1/capital/withdraw/history',
      startTime ? { startTime } : {},
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${r.id}`,
      type: TransactionType.WITHDRAWAL,
      asset: r.coin,
      quantity: String(r.amount),
      feeAmount: r.transactionFee ? String(r.transactionFee) : undefined,
      feeAsset: r.coin,
      timestamp: new Date(r.applyTime),
      raw: r,
    }));
  }

  private async fetchTrades(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const account = await this.signedGet<{
      balances: { asset: string; free: string; locked: string }[];
    }>('/api/v3/account', {}, credentials);
    const heldAssets = account.balances
      .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map((b) => b.asset);

    const results: NormalizedExchangeTransaction[] = [];
    for (const asset of heldAssets) {
      for (const quote of COMMON_QUOTES) {
        if (asset === quote) continue;
        const symbol = `${asset}${quote}`;
        try {
          const trades = await this.signedGet<BinanceTrade[]>(
            '/api/v3/myTrades',
            startTime
              ? { symbol, startTime, limit: 1000 }
              : { symbol, limit: 1000 },
            credentials,
          );
          for (const t of trades) {
            results.push({
              externalId: `trade-${t.id}`,
              type: t.isBuyer ? TransactionType.BUY : TransactionType.SELL,
              asset,
              quantity: String(t.qty),
              priceInQuote: String(t.price),
              quoteCurrency: quote,
              feeAmount: String(t.commission),
              feeAsset: t.commissionAsset,
              timestamp: new Date(t.time),
              raw: t,
            });
          }
        } catch {
          // Sembol Binance'de gecerli degil (ör. bu asset/quote cifti hic
          // islem gormemis) — beklenen bir durum, sessizce atla.
        }
      }
    }
    return results;
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    const query = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      timestamp: String(Date.now()),
      recvWindow: '10000',
    });
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(query.toString())
      .digest('hex');
    query.set('signature', signature);

    const res = await fetch(`${REST_BASE}${path}?${query.toString()}`, {
      headers: { 'X-MBX-APIKEY': credentials.apiKey },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
