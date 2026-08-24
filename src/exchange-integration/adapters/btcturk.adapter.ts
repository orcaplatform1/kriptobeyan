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

const REST_BASE = 'https://api.btcturk.com';

interface BtcturkTrade {
  id: string;
  pair?: string;
  pairNormalized?: string;
  orderType: number;
  amount: string;
  price: string;
  fee?: string;
  timestamp: number;
}

interface BtcturkCryptoTransaction {
  id: string;
  type: 'deposit' | 'withdrawal';
  currencySymbol?: string;
  currency?: string;
  amount: string;
  timestamp: number;
}

/**
 * NOT: BtcTurk API dokumantasyonuna (github.com/BTCTrader/broker-api-docs)
 * gore yazildi, gercek hesapla test EDILMEDI. BtcTurk API'sinde Binance/
 * Bybit/OKX'teki gibi "bu key'in izin seviyesi ne" diyen ayri bir uc nokta
 * YOK (ya da bulunamadi) — bu yuzden verifyPermissionLevel her zaman UNKNOWN
 * doner, izin kontrolu tamamen kullanicinin "read-only onayi" checkbox'ina
 * dayanir. Canliya almadan once BtcTurk'un guncel dokumantasyonuyla teyit
 * edilmeli.
 */
@Injectable()
export class BtcturkAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.BTCTURK;
  private readonly logger = new Logger(BtcturkAdapter.name);

  verifyPermissionLevel(): Promise<ApiPermissionLevel> {
    return Promise.resolve(ApiPermissionLevel.UNKNOWN);
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const results: NormalizedExchangeTransaction[] = [];
    results.push(...(await this.fetchTrades(credentials, since)));
    results.push(...(await this.fetchCryptoTransactions(credentials, since)));
    return results;
  }

  private async fetchTrades(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = {};
    if (since) params.startDate = String(since.getTime());
    const res = await this.signedGet<{ data: BtcturkTrade[] }>(
      '/api/v1/users/transactions/trade',
      params,
      credentials,
    );
    return (res.data ?? []).map((t): NormalizedExchangeTransaction => {
      const [asset, quote] = String(t.pair ?? t.pairNormalized ?? '').split(
        '_',
      );
      return {
        externalId: `trade-${t.id}`,
        type: t.orderType === 0 ? TransactionType.BUY : TransactionType.SELL,
        asset: asset || t.pairNormalized || 'UNKNOWN',
        quantity: String(t.amount),
        priceInQuote: String(t.price),
        quoteCurrency: quote,
        feeAmount: t.fee ? String(Math.abs(Number(t.fee))) : undefined,
        feeAsset: quote,
        timestamp: new Date(t.timestamp),
        raw: t,
      };
    });
  }

  private async fetchCryptoTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ) {
    const params: Record<string, string> = {};
    if (since) params.startDate = String(since.getTime());
    const res = await this.signedGet<{ data: BtcturkCryptoTransaction[] }>(
      '/api/v1/users/transactions/crypto',
      params,
      credentials,
    );
    return (res.data ?? []).map((c): NormalizedExchangeTransaction => ({
      externalId: `crypto-${c.id}`,
      type:
        c.type === 'deposit'
          ? TransactionType.DEPOSIT
          : TransactionType.WITHDRAWAL,
      asset: c.currencySymbol ?? c.currency ?? 'UNKNOWN',
      quantity: String(c.amount),
      timestamp: new Date(c.timestamp),
      raw: c,
    }));
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string>,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    const timestamp = String(Date.now());
    const secretRaw = Buffer.from(credentials.apiSecret, 'base64');
    const signature = createHmac('sha256', secretRaw)
      .update(`${credentials.apiKey}${timestamp}`)
      .digest('base64');

    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${REST_BASE}${path}${query ? `?${query}` : ''}`, {
      headers: {
        'X-PCK': credentials.apiKey,
        'X-Stamp': timestamp,
        'X-Signature': signature,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BtcTurk API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
