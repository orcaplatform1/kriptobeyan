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

const REST_BASE = 'https://api.bybit.com';
const RECV_WINDOW = '10000';

// Bybit V5 /v5/execution/list startTime-endTime araligini EN FAZLA 7 gunle
// sinirliyor — daha genis bir gecmis istenirse bu pencerelerle geriye dogru
// sayfalanmali (deposit/withdraw uc noktalari daha esnek, sadece cursor
// yeterli — bkz. fetchCursorPaginated).
const EXECUTION_WINDOW_MS = 6 * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;
// Bybit "rate limit asildi" (retCode) — bkz. https://bybit-exchange.github.io/docs/v5/error-code
const RATE_LIMIT_RET_CODES = new Set([10006, 10018]);

interface BybitExecution {
  execId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  execQty: string;
  execPrice: string;
  execFee?: string;
  feeCurrency?: string;
  execTime: string;
}

interface BybitAssetRow {
  txID: string;
  coin: string;
  amount: string;
  successAt?: string;
  updateTime?: string;
  withdrawFee?: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bybit V5 API dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI (bkz. Binance adaptorundeki ayni uyari). Sayfalama/pencere
 * varsayimlari (execution/list icin 7 gunluk pencere, cursor tabanli
 * sayfalama) dokumantasyona dayanir ama canli dogrulanmadi.
 */
@Injectable()
export class BybitAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.BYBIT;
  private readonly logger = new Logger(BybitAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      const res = await this.signedGet<{
        result: { readOnly: number; permissions: Record<string, string[]> };
      }>('/v5/user/query-api', {}, credentials);
      const { readOnly, permissions } = res.result;
      if (readOnly === 1) return ApiPermissionLevel.READ_ONLY;
      const hasWithdraw =
        permissions?.Wallet?.includes('AccountTransfer') ||
        permissions?.Wallet?.includes('Withdraw');
      if (hasWithdraw) return ApiPermissionLevel.WITHDRAW;
      return ApiPermissionLevel.TRADE;
    } catch (err) {
      this.logger.warn(
        `Bybit izin dogrulama basarisiz: ${(err as Error).message}`,
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
    results.push(...(await this.fetchExecutions(credentials, startTime)));
    results.push(...(await this.fetchDeposits(credentials, startTime)));
    results.push(...(await this.fetchWithdrawals(credentials, startTime)));
    return results;
  }

  /** Bir sayfa isteği + donen nextPageCursor'i takip ederek TUM sayfalari
   *  cekme yardimcisi — deposit/withdraw/execution uc noktalarinin ucunun
   *  ortak "result: { list|rows, nextPageCursor }" seklini paylasmasindan
   *  yararlanir. */
  private async fetchCursorPaginated<TRow>(
    path: string,
    baseParams: Record<string, string | number>,
    credentials: ExchangeCredentials,
    listKey: 'list' | 'rows',
  ): Promise<TRow[]> {
    const results: TRow[] = [];
    let cursor: string | undefined;

    for (;;) {
      const params = cursor ? { ...baseParams, cursor } : baseParams;
      const res = await this.signedGet<{
        result: { nextPageCursor?: string } & Record<'list' | 'rows', TRow[]>;
      }>(path, params, credentials);
      const page = res.result[listKey] ?? [];
      results.push(...page);
      cursor = res.result.nextPageCursor;
      if (!cursor || page.length === 0) break;
    }
    return results;
  }

  private async fetchExecutions(credentials: ExchangeCredentials, startTime: number) {
    const results: NormalizedExchangeTransaction[] = [];
    let windowStart = startTime;
    const now = Date.now();

    while (windowStart < now) {
      const windowEnd = Math.min(windowStart + EXECUTION_WINDOW_MS, now);
      const rows = await this.fetchCursorPaginated<BybitExecution>(
        '/v5/execution/list',
        { category: 'spot', startTime: windowStart, endTime: windowEnd, limit: 100 },
        credentials,
        'list',
      );
      for (const e of rows) {
        const [asset, quote] = this.splitSymbol(e.symbol);
        results.push({
          externalId: `exec-${e.execId}`,
          type: e.side === 'Buy' ? TransactionType.BUY : TransactionType.SELL,
          asset,
          quantity: String(e.execQty),
          priceInQuote: String(e.execPrice),
          quoteCurrency: quote,
          feeAmount: e.execFee ? String(e.execFee) : undefined,
          feeAsset: e.feeCurrency ?? quote,
          timestamp: new Date(Number(e.execTime)),
          raw: e,
        });
      }
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async fetchDeposits(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchCursorPaginated<BybitAssetRow>(
      '/v5/asset/deposit/query-record',
      { startTime, limit: 50 },
      credentials,
      'rows',
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.txID}`,
      type: TransactionType.DEPOSIT,
      asset: r.coin,
      quantity: String(r.amount),
      timestamp: new Date(Number(r.successAt)),
      raw: r,
    }));
  }

  private async fetchWithdrawals(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchCursorPaginated<BybitAssetRow>(
      '/v5/asset/withdraw/query-record',
      { startTime, limit: 50 },
      credentials,
      'rows',
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${r.txID}`,
      type: TransactionType.WITHDRAWAL,
      asset: r.coin,
      quantity: String(r.amount),
      feeAmount: r.withdrawFee ? String(r.withdrawFee) : undefined,
      feeAsset: r.coin,
      timestamp: new Date(Number(r.updateTime)),
      raw: r,
    }));
  }

  private splitSymbol(symbol: string): [string, string] {
    // Bybit spot sembolleri genelde "BTCUSDT" gibi ayracsiz gelir; en yaygin
    // quote'lari deneyerek ayiriyoruz (kesin cozum icin instruments-info
    // uc noktasindan sembol listesi cekilebilir — ileride gelistirilebilir).
    for (const quote of ['USDT', 'USDC', 'TRY', 'BTC', 'ETH']) {
      if (symbol.endsWith(quote) && symbol.length > quote.length) {
        return [symbol.slice(0, -quote.length), quote];
      }
    }
    return [symbol, ''];
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
    attempt = 0,
  ): Promise<T> {
    const timestamp = String(Date.now());
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
    );
    const queryString = query.toString();
    const payload = timestamp + credentials.apiKey + RECV_WINDOW + queryString;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(payload)
      .digest('hex');

    const res = await fetch(
      `${REST_BASE}${path}${queryString ? `?${queryString}` : ''}`,
      {
        headers: {
          'X-BAPI-API-KEY': credentials.apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        },
      },
    );

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Bybit 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bybit API hatası (${path}): ${res.status} ${body}`);
    }
    const json = (await res.json()) as { retCode: number; retMsg: string } & T;

    if (RATE_LIMIT_RET_CODES.has(json.retCode) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Bybit retCode ${json.retCode} (rate limit) — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (json.retCode !== 0) {
      throw new Error(`Bybit API hatası (${path}): ${json.retMsg}`);
    }
    return json;
  }
}
