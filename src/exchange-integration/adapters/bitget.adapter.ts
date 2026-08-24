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

const REST_BASE = 'https://api.bitget.com';
const COMMON_QUOTES = ['USDT', 'USDC', 'BTC'];

const MAX_WINDOW_MS = 89 * 24 * 60 * 60 * 1000; // deposit/withdraw kayit uc noktalari icin resmi pencere siniri belirtilmiyor, temkinli varsayim
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = '100';
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

interface BitgetResponse<T> {
  code: string;
  msg: string;
  data: T;
}

interface BitgetAsset {
  coin: string;
  available: string;
  frozen: string;
  locked: string;
}

interface BitgetFill {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  priceAvg: string;
  size: string;
  feeDetail?: { feeCoin: string; totalFee: string };
  cTime: string;
}

interface BitgetDeposit {
  orderId: string;
  tradeId: string;
  coin: string;
  size: string;
  status: string;
  cTime: string;
}

interface BitgetWithdrawal {
  orderId: string;
  tradeId: string;
  coin: string;
  size: string;
  fee: string;
  status: string;
  cTime: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bu adaptor Bitget'in resmi API v2 dokumantasyonuna (bitget.com/
 * api-doc/spot/trade/Get-Fills, .../wallet/deposit-records, .../wallet/
 * withdrawal-records) ve aktif bakimli acik kaynakli istemci
 * tiagosiebler/bitget-api'nin kaynak koduna (uc nokta yollari, imza semasi
 * ve yanit alan isimleri buradan capraz dogrulandi) gore yazildi ancak
 * gercek, kimlikli bir hesaba karsi TEST EDILMEDI. Bitget diger cogu
 * borsadan farkli olarak, key'in kendi izin seviyesini sorgulayan ayri bir
 * uc nokta sunmuyor (bulunamadi) — verifyPermissionLevel bu yuzden sadece
 * key'in gecerliligini dogrular, UNKNOWN doner.
 */
@Injectable()
export class BitgetAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.BITGET;
  private readonly logger = new Logger(BitgetAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      await this.signedGet<BitgetAsset[]>(
        '/api/v2/spot/account/assets',
        {},
        credentials,
      );
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `Bitget izin dogrulama basarisiz: ${(err as Error).message}`,
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
  ): Promise<T[]> {
    const results: T[] = [];
    let windowStart = startTime;
    const now = Date.now();

    while (windowStart < now) {
      const windowEnd = Math.min(windowStart + MAX_WINDOW_MS, now);
      const page = await this.signedGet<T[]>(
        path,
        {
          startTime: String(windowStart),
          endTime: String(windowEnd),
          limit: PAGE_LIMIT,
        },
        credentials,
      );
      results.push(...page);
      windowStart = windowEnd + 1;
    }
    return results;
  }

  private async fetchDeposits(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BitgetDeposit>(
      '/api/v2/spot/wallet/deposit-records',
      startTime,
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.tradeId || r.orderId}`,
      type: TransactionType.DEPOSIT,
      asset: r.coin,
      quantity: r.size,
      timestamp: new Date(Number(r.cTime)),
      raw: r,
    }));
  }

  private async fetchWithdrawals(credentials: ExchangeCredentials, startTime: number) {
    const rows = await this.fetchWindowed<BitgetWithdrawal>(
      '/api/v2/spot/wallet/withdrawal-records',
      startTime,
      credentials,
    );
    return rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${r.tradeId || r.orderId}`,
      type: TransactionType.WITHDRAWAL,
      asset: r.coin,
      quantity: r.size,
      feeAmount: r.fee,
      feeAsset: r.coin,
      timestamp: new Date(Number(r.cTime)),
      raw: r,
    }));
  }

  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const assets = await this.signedGet<BitgetAsset[]>(
      '/api/v2/spot/account/assets',
      {},
      credentials,
    );
    const heldAssets = assets
      .filter((a) => parseFloat(a.available) > 0 || parseFloat(a.frozen) > 0 || parseFloat(a.locked) > 0)
      .map((a) => a.coin);

    const results: NormalizedExchangeTransaction[] = [];
    for (const asset of heldAssets) {
      for (const quote of COMMON_QUOTES) {
        if (asset === quote) continue;
        const symbol = `${asset}${quote}`;
        try {
          const fills = await this.fetchFillsForSymbol(symbol, startTime, credentials);
          for (const f of fills) {
            results.push({
              externalId: `trade-${f.tradeId}`,
              type: f.side === 'buy' ? TransactionType.BUY : TransactionType.SELL,
              asset,
              quantity: f.size,
              priceInQuote: f.priceAvg,
              quoteCurrency: quote,
              feeAmount: f.feeDetail?.totalFee,
              feeAsset: f.feeDetail?.feeCoin,
              timestamp: new Date(Number(f.cTime)),
              raw: f,
            });
          }
        } catch {
          // Sembol Bitget'te gecerli degil (ör. bu asset/quote cifti hic
          // islem gormemis) — beklenen bir durum, sessizce atla.
        }
      }
    }
    return results;
  }

  /** Bitget /spot/trade/fills sayfalamayi idLessThan (donen son fill'in
   *  tradeId'sinden kucuk) ile yapar — bkz. resmi dokumantasyon. */
  private async fetchFillsForSymbol(
    symbol: string,
    startTime: number,
    credentials: ExchangeCredentials,
  ): Promise<BitgetFill[]> {
    const results: BitgetFill[] = [];
    let idLessThan: string | undefined;

    for (;;) {
      const params: Record<string, string> = idLessThan
        ? { symbol, idLessThan, limit: PAGE_LIMIT }
        : { symbol, startTime: String(startTime), limit: PAGE_LIMIT };
      const page = await this.signedGet<BitgetFill[]>(
        '/api/v2/spot/trade/fills',
        params,
        credentials,
      );
      results.push(...page);
      if (page.length < Number(PAGE_LIMIT)) break;
      idLessThan = page[page.length - 1].tradeId;
    }
    return results;
  }

  /** Bitget imza semasi: sign = base64(HMAC-SHA256(timestamp + "GET" +
   *  requestPath + "?" + queryString, secret)) — header'lar ACCESS-KEY,
   *  ACCESS-PASSPHRASE, ACCESS-TIMESTAMP, ACCESS-SIGN (bkz. adaptor ustu
   *  yorum, kaynak: bitget.com/api-doc/common/signature). */
  private async signedGet<T>(
    path: string,
    params: Record<string, string>,
    credentials: ExchangeCredentials,
    attempt = 0,
  ): Promise<T> {
    const query = new URLSearchParams(params);
    const queryString = query.toString();
    const requestPath = queryString ? `${path}?${queryString}` : path;
    const timestamp = String(Date.now());
    const signaturePayload = `${timestamp}GET${requestPath}`;
    const sign = createHmac('sha256', credentials.apiSecret)
      .update(signaturePayload)
      .digest('base64');

    const res = await fetch(`${REST_BASE}${requestPath}`, {
      headers: {
        'ACCESS-KEY': credentials.apiKey,
        'ACCESS-SIGN': sign,
        'ACCESS-TIMESTAMP': timestamp,
        'ACCESS-PASSPHRASE': credentials.passphrase ?? '',
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Bitget 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bitget API hatası (${path}): ${res.status} ${body}`);
    }

    const parsed = (await res.json()) as BitgetResponse<T>;
    if (parsed.code !== '00000') {
      throw new Error(`Bitget API hatası (${path}): ${parsed.code} ${parsed.msg}`);
    }
    return parsed.data;
  }
}
