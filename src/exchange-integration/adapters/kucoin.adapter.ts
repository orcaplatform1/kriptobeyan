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

const REST_BASE = 'https://api.kucoin.com';

interface KucoinFill {
  tradeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: string;
  size: string;
  fee: string;
  feeCurrency: string;
  createdAt: number;
}

interface KucoinTransfer {
  walletTxId: string;
  currency: string;
  amount: string;
  fee: string;
  createdAt: number;
}

/**
 * NOT: KuCoin API v2 dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI (bkz. Binance adaptorundeki ayni uyari).
 */
@Injectable()
export class KucoinAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.KUCOIN;
  private readonly logger = new Logger(KucoinAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      const res = await this.signedGet<{ data: { permission?: string } }>(
        '/api/v1/user/api-key',
        {},
        credentials,
      );
      const perm = (res.data?.permission ?? '').toLowerCase();
      if (perm.includes('withdraw')) return ApiPermissionLevel.WITHDRAW;
      if (perm.includes('trade')) return ApiPermissionLevel.TRADE;
      if (perm.includes('general')) return ApiPermissionLevel.READ_ONLY;
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `KuCoin izin dogrulama basarisiz: ${(err as Error).message}`,
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
    const params: Record<string, string> = {};
    if (since) params.startAt = String(since.getTime());
    const res = await this.signedGet<{ data: { items: KucoinFill[] } }>(
      '/api/v1/fills',
      params,
      credentials,
    );
    return res.data.items.map((f): NormalizedExchangeTransaction => {
      const [asset, quote] = f.symbol.split('-');
      return {
        externalId: `fill-${f.tradeId}`,
        type: f.side === 'buy' ? TransactionType.BUY : TransactionType.SELL,
        asset,
        quantity: f.size,
        priceInQuote: f.price,
        quoteCurrency: quote,
        feeAmount: f.fee,
        feeAsset: f.feeCurrency,
        timestamp: new Date(f.createdAt),
        raw: f,
      };
    });
  }

  private async fetchDeposits(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = {};
    if (since) params.startAt = String(since.getTime());
    const res = await this.signedGet<{ data: { items: KucoinTransfer[] } }>(
      '/api/v1/deposits',
      params,
      credentials,
    );
    return res.data.items.map((d): NormalizedExchangeTransaction => ({
      externalId: `deposit-${d.walletTxId}`,
      type: TransactionType.DEPOSIT,
      asset: d.currency,
      quantity: d.amount,
      timestamp: new Date(d.createdAt),
      raw: d,
    }));
  }

  private async fetchWithdrawals(
    credentials: ExchangeCredentials,
    since?: Date,
  ) {
    const params: Record<string, string> = {};
    if (since) params.startAt = String(since.getTime());
    const res = await this.signedGet<{ data: { items: KucoinTransfer[] } }>(
      '/api/v1/withdrawals',
      params,
      credentials,
    );
    return res.data.items.map((w): NormalizedExchangeTransaction => ({
      externalId: `withdrawal-${w.walletTxId}`,
      type: TransactionType.WITHDRAWAL,
      asset: w.currency,
      quantity: w.amount,
      feeAmount: w.fee,
      feeAsset: w.currency,
      timestamp: new Date(w.createdAt),
      raw: w,
    }));
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string>,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    if (!credentials.passphrase)
      throw new Error('KuCoin için passphrase gerekli');
    const query = new URLSearchParams(params).toString();
    const requestPath = query ? `${path}?${query}` : path;
    const timestamp = String(Date.now());
    const prehash = timestamp + 'GET' + requestPath;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(prehash)
      .digest('base64');
    const encryptedPassphrase = createHmac('sha256', credentials.apiSecret)
      .update(credentials.passphrase)
      .digest('base64');

    const res = await fetch(`${REST_BASE}${requestPath}`, {
      headers: {
        'KC-API-KEY': credentials.apiKey,
        'KC-API-SIGN': signature,
        'KC-API-TIMESTAMP': timestamp,
        'KC-API-PASSPHRASE': encryptedPassphrase,
        'KC-API-KEY-VERSION': '2',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`KuCoin API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
