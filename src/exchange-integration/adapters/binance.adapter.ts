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

// Binance deposit/withdraw history uc noktalari startTime/endTime arasini
// EN FAZLA 90 gune izin veriyor — daha eski veri istenirse bu pencereler
// halinde geriye dogru sayfalanmali (bkz. fetchWindowed).
const MAX_WINDOW_MS = 89 * 24 * 60 * 60 * 1000;
// Ilk baglantida "since" verilmezse ne kadar geriye gidilecek — 3 yil,
// coğu kullanicinin tum gecmisini kapsar.
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const TRADE_PAGE_LIMIT = 1000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

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
  id: number;
  isBuyer: boolean;
  qty: string;
  price: string;
  commission: string;
  commissionAsset: string;
  time: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bu adaptor Binance'in resmi REST API dokumantasyonuna gore yazildi
 * ancak gercek, kimlikli bir hesaba karsi TEST EDILMEDI (bu ortamda test
 * API key'i yok). Uretime almadan once gercek bir hesapla dogrulanmali —
 * ozellikle asagidaki sayfalama varsayimlari (90 gunluk pencere limiti,
 * trade sayfalamada fromId kullanimi) Binance dokumantasyonuna dayanir ama
 * canli dogrulanmadi.
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
    const startTime = since?.getTime() ?? Date.now() - DEFAULT_LOOKBACK_MS;
    const results: NormalizedExchangeTransaction[] = [];

    results.push(...(await this.fetchDeposits(credentials, startTime)));
    results.push(...(await this.fetchWithdrawals(credentials, startTime)));
    results.push(...(await this.fetchTrades(credentials, startTime)));

    return results;
  }

  /** deposit/withdraw uc noktalari icin 90 gunluk pencerelerle geriye
   *  dogru sayfalama — bkz. MAX_WINDOW_MS yorumu. */
  private async fetchWindowed<T>(
    path: string,
    startTime: number,
    credentials: ExchangeCredentials,
    extraParams: Record<string, string | number> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let windowStart = startTime;
    const now = Date.now();

    while (windowStart < now) {
      const windowEnd = Math.min(windowStart + MAX_WINDOW_MS, now);
      const page = await this.signedGet<T[]>(
        path,
        { ...extraParams, startTime: windowStart, endTime: windowEnd, limit: 1000 },
        credentials,
      );
      results.push(...page);
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async fetchDeposits(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BinanceDeposit>(
      '/sapi/v1/capital/deposit/hisrec',
      startTime,
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

  private async fetchWithdrawals(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BinanceWithdrawal>(
      '/sapi/v1/capital/withdraw/history',
      startTime,
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

  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
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
          const trades = await this.fetchTradesForSymbol(symbol, startTime, credentials);
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

  /** Binance'de startTime + fromId birlikte kullanilamaz — ilk sayfa
   *  startTime ile, sonraki sayfalar donen son trade'in id+1'i (fromId)
   *  ile cekilir. 1000'den az trade donerse son sayfaya varilmis demektir. */
  private async fetchTradesForSymbol(
    symbol: string,
    startTime: number,
    credentials: ExchangeCredentials,
  ): Promise<BinanceTrade[]> {
    const results: BinanceTrade[] = [];
    let fromId: number | undefined;

    for (;;) {
      const params: Record<string, string | number> = fromId
        ? { symbol, fromId, limit: TRADE_PAGE_LIMIT }
        : { symbol, startTime, limit: TRADE_PAGE_LIMIT };
      const page = await this.signedGet<BinanceTrade[]>(
        '/api/v3/myTrades',
        params,
        credentials,
      );
      results.push(...page);
      if (page.length < TRADE_PAGE_LIMIT) break;
      fromId = page[page.length - 1].id + 1;
    }
    return results;
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
    attempt = 0,
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

    // 429 = rate limit asildi, 418 = Binance IP'yi gecici banladi — ikisinde
    // de exponential backoff ile yeniden dene (Retry-After varsa onu esas al).
    if ((res.status === 429 || res.status === 418) && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Binance ${res.status} — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
