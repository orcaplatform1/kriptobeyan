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

const REST_BASE = 'https://api.kraken.com';

interface KrakenTrade {
  pair: string;
  type: 'buy' | 'sell';
  price: string;
  vol: string;
  fee: string;
  time: number;
}

interface KrakenLedgerEntry {
  refid: string;
  type: string; // 'deposit' | 'withdrawal' | digerleri (trade, transfer, vb.)
  asset: string;
  amount: string;
  fee: string;
  time: number;
}

/**
 * NOT: Kraken API dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI (bkz. Binance adaptorundeki ayni uyari). Kraken'de "bu key'in
 * izin seviyesi ne" diyen guvenilir bir uc nokta bilinmiyor — BtcTurk'te
 * oldugu gibi verifyPermissionLevel her zaman UNKNOWN doner, izin kontrolu
 * kullanicinin read-only onayina dayanir.
 */
@Injectable()
export class KrakenAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.KRAKEN;
  private readonly logger = new Logger(KrakenAdapter.name);

  verifyPermissionLevel(): Promise<ApiPermissionLevel> {
    return Promise.resolve(ApiPermissionLevel.UNKNOWN);
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const results: NormalizedExchangeTransaction[] = [];
    results.push(...(await this.fetchTrades(credentials, since)));
    results.push(...(await this.fetchLedger(credentials, since)));
    return results;
  }

  private async fetchTrades(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = {};
    if (since) params.start = String(Math.floor(since.getTime() / 1000));
    const res = await this.signedPost<{
      result: { trades: Record<string, KrakenTrade> };
    }>('/0/private/TradesHistory', params, credentials);
    return Object.entries(res.result.trades ?? {}).map(
      ([txid, t]): NormalizedExchangeTransaction => {
        const asset = t.pair.replace(/^X|Z/, '').slice(0, -3) || t.pair;
        const quote = t.pair.slice(-3);
        return {
          externalId: `trade-${txid}`,
          type: t.type === 'buy' ? TransactionType.BUY : TransactionType.SELL,
          asset,
          quantity: t.vol,
          priceInQuote: t.price,
          quoteCurrency: quote,
          feeAmount: t.fee,
          feeAsset: quote,
          timestamp: new Date(t.time * 1000),
          raw: t,
        };
      },
    );
  }

  private async fetchLedger(credentials: ExchangeCredentials, since?: Date) {
    const params: Record<string, string> = {};
    if (since) params.start = String(Math.floor(since.getTime() / 1000));
    const res = await this.signedPost<{
      result: { ledger: Record<string, KrakenLedgerEntry> };
    }>('/0/private/Ledgers', params, credentials);
    return Object.entries(res.result.ledger ?? {})
      .filter(([, e]) => e.type === 'deposit' || e.type === 'withdrawal')
      .map(([id, e]): NormalizedExchangeTransaction => ({
        externalId: `ledger-${id}`,
        type:
          e.type === 'deposit'
            ? TransactionType.DEPOSIT
            : TransactionType.WITHDRAWAL,
        asset: e.asset,
        quantity: String(Math.abs(Number(e.amount))),
        feeAmount: e.fee !== '0.0000000000' ? e.fee : undefined,
        feeAsset: e.asset,
        timestamp: new Date(e.time * 1000),
        raw: e,
      }));
  }

  private async signedPost<T>(
    path: string,
    params: Record<string, string>,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    const nonce = Date.now().toString();
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const secretBuf = Buffer.from(credentials.apiSecret, 'base64');
    const hash = createHash('sha256')
      .update(nonce + body)
      .digest();
    const hmac = createHmac('sha512', secretBuf)
      .update(Buffer.concat([Buffer.from(path), hash]))
      .digest('base64');

    const res = await fetch(`${REST_BASE}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': credentials.apiKey,
        'API-Sign': hmac,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kraken API hatası (${path}): ${res.status} ${text}`);
    }
    const json = (await res.json()) as { error: string[] } & T;
    if (json.error?.length) {
      throw new Error(`Kraken API hatası (${path}): ${json.error.join(', ')}`);
    }
    return json;
  }
}
