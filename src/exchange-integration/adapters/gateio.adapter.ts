import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
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

// Gate.io API v4 resmi dokumantasyonu (gate.com/docs/developers/apiv4) ve
// resmi Python istemcisinin (github.com/gateio/gateapi-python) OpenAPI'den
// uretilmis model/endpoint dokumanlarina gore yazildi. Base URL ve imzalama
// semasi (KEY/Timestamp/SIGN header'lari, HMAC-SHA512) dogrulandi.
const REST_BASE = 'https://api.gateio.ws/api/v4';

// /spot/my_trades ve /wallet/deposits|withdrawals uc noktalari sorgu
// araligini EN FAZLA 30 gunle sinirliyor (resmi dokumantasyonda acikca
// yaziyor) — daha eski veri istenirse bu pencerelerle geriye dogru
// sayfalanmali.
const MAX_WINDOW_MS = 29 * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
const WALLET_PAGE_LIMIT = 500;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

interface GateTrade {
  id: string;
  create_time_ms: string;
  currency_pair: string;
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  fee?: string;
  fee_currency?: string;
}

interface GateDepositOrWithdrawal {
  id: string;
  txid?: string;
  timestamp: string; // unix saniye, string
  amount: string;
  fee?: string; // sadece withdrawal'da
  currency: string;
  status: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Gate.io API v4 resmi dokumantasyonuna ve resmi python istemcisinin
 * (gateapi-python) OpenAPI ciktisina gore yazildi ancak gercek, kimlikli bir
 * hesaba karsi TEST EDILMEDI. Gate.io API key izin seviyesini (read/trade/
 * withdraw) donduren ayri bir uc nokta bulunamadi — verifyPermissionLevel bu
 * yuzden her zaman UNKNOWN doner, bu bir hata degil, API'nin bir siniri.
 */
@Injectable()
export class GateioAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.GATEIO;
  private readonly logger = new Logger(GateioAdapter.name);

  verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    void credentials;
    return Promise.resolve(ApiPermissionLevel.UNKNOWN);
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

  /** 30 gunluk pencereler + sayfa (offset/page) bazli sayfalama — Gate.io
   *  bu uc noktalarda cursor degil offset/page kullaniyor. */
  private async fetchWindowedPaged<T>(
    path: string,
    startTime: number,
    credentials: ExchangeCredentials,
    pageParamName: 'page' | 'offset',
    pageLimit: number,
    extraParams: Record<string, string | number> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let windowStart = startTime;
    const now = Date.now();

    while (windowStart < now) {
      const windowEnd = Math.min(windowStart + MAX_WINDOW_MS, now);
      let page = pageParamName === 'page' ? 1 : 0;
      for (;;) {
        const rows = await this.signedGet<T[]>(
          path,
          {
            ...extraParams,
            from: Math.floor(windowStart / 1000),
            to: Math.floor(windowEnd / 1000),
            limit: pageLimit,
            [pageParamName]: page,
          },
          credentials,
        );
        results.push(...rows);
        if (rows.length < pageLimit) break;
        page += pageParamName === 'page' ? 1 : pageLimit;
      }
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async fetchDeposits(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowedPaged<GateDepositOrWithdrawal>(
      '/wallet/deposits',
      startTime,
      credentials,
      'offset',
      WALLET_PAGE_LIMIT,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.txid ?? r.id}`,
      type: TransactionType.DEPOSIT,
      asset: r.currency,
      quantity: r.amount,
      timestamp: new Date(Number(r.timestamp) * 1000),
      raw: r,
    }));
  }

  private async fetchWithdrawals(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowedPaged<GateDepositOrWithdrawal>(
      '/wallet/withdrawals',
      startTime,
      credentials,
      'offset',
      WALLET_PAGE_LIMIT,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${r.txid ?? r.id}`,
      type: TransactionType.WITHDRAWAL,
      asset: r.currency,
      quantity: r.amount,
      feeAmount: r.fee,
      feeAsset: r.currency,
      timestamp: new Date(Number(r.timestamp) * 1000),
      raw: r,
    }));
  }

  /** /spot/my_trades diger borsalarin aksine sembol zorunlu kilmiyor — tum
   *  hesabin islem gecmisi tek uc noktadan, sembol bazinda dolasmadan
   *  cekilebiliyor. */
  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowedPaged<GateTrade>(
      '/spot/my_trades',
      startTime,
      credentials,
      'page',
      PAGE_LIMIT,
    );
    return rows.map((t): NormalizedExchangeTransaction => {
      const [asset, quote] = t.currency_pair.split('_');
      return {
        externalId: `trade-${t.id}`,
        type: t.side === 'buy' ? TransactionType.BUY : TransactionType.SELL,
        asset,
        quantity: t.amount,
        priceInQuote: t.price,
        quoteCurrency: quote,
        feeAmount: t.fee,
        feeAsset: t.fee_currency,
        timestamp: new Date(Number(t.create_time_ms)),
        raw: t,
      };
    });
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
    attempt = 0,
  ): Promise<T> {
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)]),
      ),
    );
    const queryString = query.toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const hashedPayload = createHash('sha512').update('').digest('hex');
    const signString = ['GET', path, queryString, hashedPayload, timestamp].join('\n');
    const signature = createHmac('sha512', credentials.apiSecret)
      .update(signString)
      .digest('hex');

    const res = await fetch(`${REST_BASE}${path}${queryString ? `?${queryString}` : ''}`, {
      headers: {
        KEY: credentials.apiKey,
        Timestamp: String(timestamp),
        SIGN: signature,
        Accept: 'application/json',
      },
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Gate.io 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gate.io API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
