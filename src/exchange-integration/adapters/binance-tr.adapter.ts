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

// Binance TR (binance.tr / eski adiyla trbinance.com), global Binance'den
// AYRI, SPK lisansli bir tuzel kisi (BN Teknoloji A.S.) tarafindan isletilen
// FARKLI bir platform — global Binance API anahtari burada calismaz. Ayni
// X-MBX-APIKEY header'ini ve HMAC-SHA256 imzalama seklini kullaniyor ama uc
// nokta onekleri tamamen farkli (/open/v1/...) ve sembol formati alt cizgili
// (ör. BTC_TRY, global Binance'deki BTCTRY degil).
const REST_BASE = 'https://www.binance.tr';

// binance.tr, borsa ciftlerinde oncelikle TRY kotasyonunu kullanir; USDT ve
// BTC de yaygin.
const COMMON_QUOTES = ['TRY', 'USDT', 'BTC'];

// Global Binance adaptorundeki ayni gerekce: deposit/withdraw uc noktalari
// icin pencere siniri resmi dokumantasyonda acik degil, global Binance'deki
// 90 gunluk siniri temkinli varsayim olarak koruyoruz.
const MAX_WINDOW_MS = 89 * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const TRADE_PAGE_LIMIT = 500;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

interface BinanceTrResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface BinanceTrAssetInfo {
  asset: string;
  free: string | number;
  locked: string | number;
}

interface BinanceTrAccountInfo {
  canTrade: number | boolean;
  canWithdraw: number | boolean;
  canDeposit: number | boolean;
  accountAssets: BinanceTrAssetInfo[];
}

interface BinanceTrDeposit {
  id: number;
  asset: string;
  txId?: string;
  amount: string | number;
  status: number;
  insertTime: number;
}

interface BinanceTrWithdrawal {
  id: number;
  asset: string;
  txId?: string;
  amount: string | number;
  fee?: string | number;
  status: number;
  createTime: number;
}

interface BinanceTrTrade {
  id: number;
  orderId: string;
  symbol: string;
  price: string | number;
  qty: string | number;
  commission?: string | number;
  commissionAsset?: string;
  isBuyer: boolean;
  time: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bu adaptor binance.tr'nin yayinlanmis API dokumantasyonuna ve
 * topluluk tarafindan yazilmis acik kaynakli bir istemciye (emin-karadag/
 * BinanceTR) gore yazildi ancak gercek, kimlikli bir hesaba karsi TEST
 * EDILMEDI. Ozellikle /open/v1/orders/trades uc noktasinin tam yanit
 * alanlari (field isimleri) dogrulanmis kaynakta bulunamadi — global
 * Binance'in myTrades sekline benzer varsayildi. Uretime almadan once
 * gercek bir hesapla dogrulanmali.
 */
@Injectable()
export class BinanceTrAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.BINANCE_TR;
  private readonly logger = new Logger(BinanceTrAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      const res = await this.signedGet<BinanceTrAccountInfo>(
        '/open/v1/account/spot',
        {},
        credentials,
      );
      if (Number(res.canWithdraw)) return ApiPermissionLevel.WITHDRAW;
      if (Number(res.canTrade)) return ApiPermissionLevel.TRADE;
      return ApiPermissionLevel.READ_ONLY;
    } catch (err) {
      this.logger.warn(
        `Binance TR izin dogrulama basarisiz: ${(err as Error).message}`,
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
      const page = await this.signedGet<{ list: T[] }>(
        path,
        { ...extraParams, startTime: windowStart, endTime: windowEnd },
        credentials,
      );
      results.push(...(page.list ?? []));
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async fetchDeposits(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BinanceTrDeposit>(
      '/open/v1/deposits',
      startTime,
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.txId ?? r.id}`,
      type: TransactionType.DEPOSIT,
      asset: r.asset,
      quantity: String(r.amount),
      timestamp: new Date(r.insertTime),
      raw: r,
    }));
  }

  private async fetchWithdrawals(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BinanceTrWithdrawal>(
      '/open/v1/withdraws',
      startTime,
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${r.txId ?? r.id}`,
      type: TransactionType.WITHDRAWAL,
      asset: r.asset,
      quantity: String(r.amount),
      feeAmount: r.fee !== undefined ? String(r.fee) : undefined,
      feeAsset: r.asset,
      timestamp: new Date(r.createTime),
      raw: r,
    }));
  }

  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const account = await this.signedGet<BinanceTrAccountInfo>(
      '/open/v1/account/spot',
      {},
      credentials,
    );
    const heldAssets = (account.accountAssets ?? [])
      .filter((a) => parseFloat(String(a.free)) > 0 || parseFloat(String(a.locked)) > 0)
      .map((a) => a.asset);

    const results: NormalizedExchangeTransaction[] = [];
    for (const asset of heldAssets) {
      for (const quote of COMMON_QUOTES) {
        if (asset === quote) continue;
        // binance.tr sembol formati alt cizgili (BTC_TRY), global
        // Binance'deki bitisik formattan (BTCTRY) farkli.
        const symbol = `${asset}_${quote}`;
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
              feeAmount: t.commission !== undefined ? String(t.commission) : undefined,
              feeAsset: t.commissionAsset,
              timestamp: new Date(t.time),
              raw: t,
            });
          }
        } catch {
          // Sembol binance.tr'de gecerli degil — beklenen bir durum,
          // sessizce atla (bkz. Binance global adaptorundeki ayni desen).
        }
      }
    }
    return results;
  }

  private async fetchTradesForSymbol(
    symbol: string,
    startTime: number,
    credentials: ExchangeCredentials,
  ): Promise<BinanceTrTrade[]> {
    const results: BinanceTrTrade[] = [];
    let fromId: number | undefined;

    for (;;) {
      const params: Record<string, string | number> = fromId
        ? { symbol, fromId, limit: TRADE_PAGE_LIMIT }
        : { symbol, startTime, limit: TRADE_PAGE_LIMIT };
      const page = await this.signedGet<{ list: BinanceTrTrade[] }>(
        '/open/v1/orders/trades',
        params,
        credentials,
      );
      const rows = page.list ?? [];
      results.push(...rows);
      if (rows.length < TRADE_PAGE_LIMIT) break;
      fromId = rows[rows.length - 1].id + 1;
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

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Binance TR 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Binance TR API hatası (${path}): ${res.status} ${body}`);
    }

    const parsed = (await res.json()) as BinanceTrResponse<T>;
    if (parsed.code !== 0) {
      throw new Error(`Binance TR API hatası (${path}): ${parsed.code} ${parsed.msg ?? ''}`);
    }
    return parsed.data;
  }
}
