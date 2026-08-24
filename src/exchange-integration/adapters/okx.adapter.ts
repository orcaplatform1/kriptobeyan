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

const REST_BASE = 'https://www.okx.com';

interface OkxFill {
  tradeId: string;
  billId: string;
  instId: string;
  side: 'buy' | 'sell';
  fillSz: string;
  fillPx: string;
  fee?: string;
  feeCcy?: string;
  ts: string;
}

interface OkxDeposit {
  depId: string;
  ccy: string;
  amt: string;
  ts: string;
}

interface OkxWithdrawal {
  wdId: string;
  ccy: string;
  amt: string;
  fee?: string;
  ts: string;
}

/**
 * NOT: OKX V5 API dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI. `/api/v5/account/apikey` uc noktasinin tam yaniti (izin
 * alaninin formati) hafizadan yazildi — canliya almadan once OKX'in guncel
 * dokumantasyonuyla (okx.com/docs-v5) teyit edilmeli, ozellikle
 * verifyPermissionLevel.
 */
@Injectable()
export class OkxAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.OKX;
  private readonly logger = new Logger(OkxAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      const res = await this.signedGet<{ data: { perm: string }[] }>(
        '/api/v5/account/apikey',
        {},
        credentials,
      );
      const perm = res.data?.[0]?.perm ?? '';
      if (perm.includes('withdraw')) return ApiPermissionLevel.WITHDRAW;
      if (perm.includes('trade')) return ApiPermissionLevel.TRADE;
      if (perm.includes('read')) return ApiPermissionLevel.READ_ONLY;
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `OKX izin dogrulama basarisiz: ${(err as Error).message}`,
      );
      return ApiPermissionLevel.UNKNOWN;
    }
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const results: NormalizedExchangeTransaction[] = [];
    results.push(...(await this.fetchFills(credentials, since)));
    results.push(...(await this.fetchDeposits(credentials, since)));
    results.push(...(await this.fetchWithdrawals(credentials, since)));
    return results;
  }

  private async fetchFills(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = { instType: 'SPOT' };
    if (since) params.begin = String(since.getTime());
    const res = await this.signedGet<{ data: OkxFill[] }>(
      '/api/v5/trade/fills-history',
      params,
      credentials,
    );
    return res.data.map((f): NormalizedExchangeTransaction => {
      const [asset, quote] = String(f.instId).split('-');
      return {
        externalId: `fill-${f.tradeId}-${f.billId}`,
        type: f.side === 'buy' ? TransactionType.BUY : TransactionType.SELL,
        asset,
        quantity: String(f.fillSz),
        priceInQuote: String(f.fillPx),
        quoteCurrency: quote,
        feeAmount: f.fee ? String(Math.abs(Number(f.fee))) : undefined,
        feeAsset: f.feeCcy,
        timestamp: new Date(Number(f.ts)),
        raw: f,
      };
    });
  }

  private async fetchDeposits(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = {};
    if (since) params.after = String(since.getTime());
    const res = await this.signedGet<{ data: OkxDeposit[] }>(
      '/api/v5/asset/deposit-history',
      params,
      credentials,
    );
    return res.data.map((d): NormalizedExchangeTransaction => ({
      externalId: `deposit-${d.depId}`,
      type: TransactionType.DEPOSIT,
      asset: d.ccy,
      quantity: String(d.amt),
      timestamp: new Date(Number(d.ts)),
      raw: d,
    }));
  }

  private async fetchWithdrawals(
    credentials: ExchangeCredentials,
    since?: Date,
  ) {
    const params: Record<string, string> = {};
    if (since) params.after = String(since.getTime());
    const res = await this.signedGet<{ data: OkxWithdrawal[] }>(
      '/api/v5/asset/withdrawal-history',
      params,
      credentials,
    );
    return res.data.map((w): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${w.wdId}`,
      type: TransactionType.WITHDRAWAL,
      asset: w.ccy,
      quantity: String(w.amt),
      feeAmount: w.fee ? String(w.fee) : undefined,
      feeAsset: w.ccy,
      timestamp: new Date(Number(w.ts)),
      raw: w,
    }));
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string>,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    if (!credentials.passphrase) {
      throw new Error('OKX için passphrase gerekli');
    }
    const query = new URLSearchParams(params).toString();
    const requestPath = query ? `${path}?${query}` : path;
    const timestamp = new Date().toISOString();
    const prehash = timestamp + 'GET' + requestPath;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(prehash)
      .digest('base64');

    const res = await fetch(`${REST_BASE}${requestPath}`, {
      headers: {
        'OK-ACCESS-KEY': credentials.apiKey,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': credentials.passphrase,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OKX API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
