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

// HTX (eski adiyla Huobi) — imzalama semasi Binance ailesinden tamamen
// farkli: HMAC-SHA256 + Base64 (hex degil), imza query string'de degil
// "pre-signed text" (METHOD\nHOST\nPATH\nsirali-query-string) uzerinden
// hesaplaniyor, ve Timestamp ISO8601 (saniye hassasiyetinde, UTC) olarak
// gonderiliyor — bkz. https://huobiapi.github.io/docs/spot/v1/en/
const REST_BASE = 'https://api.huobi.pro';
const HOST = 'api.huobi.pro';

const COMMON_QUOTES = ['usdt', 'try', 'btc', 'usdc'];

// "Search Match Results" (/v1/order/matchresults) resmi dokumantasyona gore
// EN FAZLA 2 gunluk pencere kabul ediyor — Binance/Bybit'ten cok daha dar.
const MATCH_RESULTS_WINDOW_MS = 2 * 24 * 60 * 60 * 1000 - 1000;
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

interface HtxAccount {
  id: number;
  type: string;
  state: string;
}

interface HtxBalance {
  currency: string;
  type: 'trade' | 'frozen';
  balance: string;
}

interface HtxMatchResult {
  id: number;
  symbol: string;
  type: string; // ör. "buy-limit", "sell-market"
  role: 'taker' | 'maker';
  price: string;
  'filled-amount': string;
  'filled-fees': string;
  'fee-currency': string;
  'created-at': number;
}

interface HtxDepositWithdraw {
  id: number;
  type: 'deposit' | 'withdraw';
  currency: string;
  'tx-hash'?: string;
  amount: string;
  fee?: string;
  state: string;
  'created-at': number;
  'updated-at'?: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bu adaptor HTX'in resmi API dokumantasyonuna (huobiapi.github.io/docs/
 * spot/v1/en/) gore yazildi ancak gercek, kimlikli bir hesaba karsi TEST
 * EDILMEDI. matchresults/deposit-withdraw yanit alanlari (özellikle "type",
 * "role", "fee-currency" gibi alanlar) Huobi/HTX'in bilinen public API
 * semasindan yazildi, dokumantasyon sayfasinda alan bazinda teyit edilemedi
 * — uretime almadan once gercek bir hesapla dogrulanmali.
 */
@Injectable()
export class HtxAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.HTX;
  private readonly logger = new Logger(HtxAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      // HTX'in API key izin seviyesini doner tek bir uc noktasi yok —
      // hesabin var olmasi + spot bakiyeye okuma erisimi READ_ONLY icin
      // yeterli kanit sayiliyor. Trade/withdraw izni ayri bir uc noktadan
      // dogrulanamiyor, bu yuzden UNKNOWN'a dusuluyor (guvenli varsayim:
      // asla WITHDRAW/TRADE iddia edilmiyor).
      await this.getSpotAccountId(credentials);
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `HTX izin dogrulama basarisiz: ${(err as Error).message}`,
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

    results.push(...(await this.fetchDepositsOrWithdrawals(credentials, 'deposit', startTime)));
    results.push(...(await this.fetchDepositsOrWithdrawals(credentials, 'withdraw', startTime)));
    results.push(...(await this.fetchTrades(credentials, startTime)));

    return results;
  }

  private async getSpotAccountId(credentials: ExchangeCredentials): Promise<number> {
    const accounts = await this.signedRequest<HtxAccount[]>(
      'GET',
      '/v1/account/accounts',
      {},
      credentials,
    );
    const spot = accounts.find((a) => a.type === 'spot' && a.state === 'working');
    if (!spot) throw new Error('HTX spot hesabi bulunamadi');
    return spot.id;
  }

  /** deposit-withdraw uc noktasi zaman araligi almiyor — cursor (from-id)
   *  ile geriye dogru sayfalanip startTime'dan eskiye dusunce durduruluyor. */
  private async fetchDepositsOrWithdrawals(
    credentials: ExchangeCredentials,
    type: 'deposit' | 'withdraw',
    startTime: number,
  ) {
    const results: NormalizedExchangeTransaction[] = [];
    let fromId: number | undefined;

    for (;;) {
      const params: Record<string, string | number> = { type, size: PAGE_SIZE };
      if (fromId !== undefined) {
        params['from'] = fromId;
        params['direct'] = 'next';
      }
      const page = await this.signedRequest<HtxDepositWithdraw[]>(
        'GET',
        '/v1/query/deposit-withdraw',
        params,
        credentials,
      );
      if (page.length === 0) break;

      for (const r of page) {
        if (r['created-at'] < startTime) continue;
        results.push({
          externalId: `${type}-${r.id}`,
          type: type === 'deposit' ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
          asset: r.currency.toUpperCase(),
          quantity: r.amount,
          feeAmount: r.fee,
          feeAsset: r.fee ? r.currency.toUpperCase() : undefined,
          timestamp: new Date(r['created-at']),
          raw: r,
        });
      }

      const oldest = page[page.length - 1];
      if (page.length < PAGE_SIZE || oldest['created-at'] < startTime) break;
      fromId = oldest.id;
    }
    return results;
  }

  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const accountId = await this.getSpotAccountId(credentials);
    const balances = await this.signedRequest<{ list: HtxBalance[] }>(
      'GET',
      `/v1/account/accounts/${accountId}/balance`,
      {},
      credentials,
    );
    const heldAssets = Array.from(
      new Set(
        (balances.list ?? [])
          .filter((b) => parseFloat(b.balance) > 0)
          .map((b) => b.currency.toLowerCase()),
      ),
    );

    const results: NormalizedExchangeTransaction[] = [];
    for (const asset of heldAssets) {
      for (const quote of COMMON_QUOTES) {
        if (asset === quote) continue;
        const symbol = `${asset}${quote}`;
        try {
          const trades = await this.fetchMatchResultsWindowed(symbol, startTime, credentials);
          for (const t of trades) {
            const isBuy = t.type.startsWith('buy');
            results.push({
              externalId: `trade-${t.id}`,
              type: isBuy ? TransactionType.BUY : TransactionType.SELL,
              asset: asset.toUpperCase(),
              quantity: t['filled-amount'],
              priceInQuote: t.price,
              quoteCurrency: quote.toUpperCase(),
              feeAmount: t['filled-fees'],
              feeAsset: t['fee-currency']?.toUpperCase(),
              timestamp: new Date(t['created-at']),
              raw: t,
            });
          }
        } catch {
          // Sembol HTX'te gecerli degil — beklenen bir durum, sessizce atla.
        }
      }
    }
    return results;
  }

  /** matchresults EN FAZLA 2 gunluk pencere kabul ediyor — bkz.
   *  MATCH_RESULTS_WINDOW_MS yorumu. */
  private async fetchMatchResultsWindowed(
    symbol: string,
    startTime: number,
    credentials: ExchangeCredentials,
  ): Promise<HtxMatchResult[]> {
    const results: HtxMatchResult[] = [];
    let windowStart = startTime;
    const now = Date.now();

    while (windowStart < now) {
      const windowEnd = Math.min(windowStart + MATCH_RESULTS_WINDOW_MS, now);
      const page = await this.signedRequest<HtxMatchResult[]>(
        'GET',
        '/v1/order/matchresults',
        {
          symbol,
          'start-time': windowStart,
          'end-time': windowEnd,
          size: PAGE_SIZE,
        },
        credentials,
      );
      results.push(...page);
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async signedRequest<T>(
    method: 'GET',
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
    attempt = 0,
  ): Promise<T> {
    const timestamp = new Date().toISOString().slice(0, 19);
    const allParams: Record<string, string> = {
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      AccessKeyId: credentials.apiKey,
      SignatureMethod: 'HmacSHA256',
      SignatureVersion: '2',
      Timestamp: timestamp,
    };
    // HTX imzasi, parametrelerin ASCII sirasina gore siralanmis
    // url-encoded halinin uzerinden hesaplaniyor.
    const sortedQuery = Object.keys(allParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
      .join('&');
    const preSignedText = `${method}\n${HOST}\n${path}\n${sortedQuery}`;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(preSignedText)
      .digest('base64');

    const finalQuery = `${sortedQuery}&Signature=${encodeURIComponent(signature)}`;
    const res = await fetch(`${REST_BASE}${path}?${finalQuery}`, { method });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `HTX 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedRequest<T>(method, path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTX API hatası (${path}): ${res.status} ${body}`);
    }

    const parsed = (await res.json()) as { status: string; data: T; 'err-msg'?: string };
    if (parsed.status !== 'ok') {
      throw new Error(`HTX API hatası (${path}): ${parsed['err-msg'] ?? parsed.status}`);
    }
    return parsed.data;
  }
}
