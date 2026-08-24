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

/**
 * NOT: Bybit V5 API dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI (bkz. Binance adaptorundeki ayni uyari).
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
    const startTime = since?.getTime();
    const results: NormalizedExchangeTransaction[] = [];
    results.push(...(await this.fetchExecutions(credentials, startTime)));
    results.push(...(await this.fetchDeposits(credentials, startTime)));
    results.push(...(await this.fetchWithdrawals(credentials, startTime)));
    return results;
  }

  private async fetchExecutions(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const params: Record<string, string | number> = {
      category: 'spot',
      limit: 100,
    };
    if (startTime) params.startTime = startTime;
    const res = await this.signedGet<{ result: { list: BybitExecution[] } }>(
      '/v5/execution/list',
      params,
      credentials,
    );
    return res.result.list.map((e): NormalizedExchangeTransaction => {
      const [asset, quote] = this.splitSymbol(e.symbol);
      return {
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
      };
    });
  }

  private async fetchDeposits(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const params: Record<string, string | number> = { limit: 50 };
    if (startTime) params.startTime = startTime;
    const res = await this.signedGet<{ result: { rows: BybitAssetRow[] } }>(
      '/v5/asset/deposit/query-record',
      params,
      credentials,
    );
    return res.result.rows.map((r): NormalizedExchangeTransaction => ({
      externalId: `deposit-${r.txID}`,
      type: TransactionType.DEPOSIT,
      asset: r.coin,
      quantity: String(r.amount),
      timestamp: new Date(Number(r.successAt)),
      raw: r,
    }));
  }

  private async fetchWithdrawals(
    credentials: ExchangeCredentials,
    startTime?: number,
  ) {
    const params: Record<string, string | number> = { limit: 50 };
    if (startTime) params.startTime = startTime;
    const res = await this.signedGet<{ result: { rows: BybitAssetRow[] } }>(
      '/v5/asset/withdraw/query-record',
      params,
      credentials,
    );
    return res.result.rows.map((r): NormalizedExchangeTransaction => ({
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
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bybit API hatası (${path}): ${res.status} ${body}`);
    }
    const json = (await res.json()) as { retCode: number; retMsg: string } & T;
    if (json.retCode !== 0) {
      throw new Error(`Bybit API hatası (${path}): ${json.retMsg}`);
    }
    return json;
  }
}
