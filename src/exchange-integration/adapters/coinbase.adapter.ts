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

// Coinbase'in eski (v2, "API Key") uc noktalari — Advanced Trade (v3) API'si
// farkli bir auth semasi kullaniyor; v2 daha uzun suredir stabil ve daha
// yuksek guvenle biliniyor. Hesap+islem gecmisi icin yeterli.
const REST_BASE = 'https://api.coinbase.com';

interface CoinbaseAccount {
  id: string;
  currency: { code: string } | string;
}

interface CoinbaseTransaction {
  id: string;
  type: string; // 'buy' | 'sell' | 'send' | 'pro_deposit' | 'pro_withdrawal' | ...
  amount: { amount: string; currency: string };
  native_amount: { amount: string; currency: string };
  created_at: string;
}

/**
 * NOT: Coinbase v2 API dokumantasyonuna gore yazildi, gercek hesapla test
 * EDILMEDI (bkz. Binance adaptorundeki ayni uyari). Coinbase'de "bu key'in
 * izin seviyesi ne" diyen genel kullanicilara acik bir uc nokta bilinmiyor
 * — BtcTurk/Kraken'de oldugu gibi UNKNOWN doner.
 */
@Injectable()
export class CoinbaseAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.COINBASE;
  private readonly logger = new Logger(CoinbaseAdapter.name);

  verifyPermissionLevel(): Promise<ApiPermissionLevel> {
    return Promise.resolve(ApiPermissionLevel.UNKNOWN);
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const accounts = await this.signedGet<{ data: CoinbaseAccount[] }>(
      '/v2/accounts',
      credentials,
    );
    const results: NormalizedExchangeTransaction[] = [];

    for (const account of accounts.data) {
      const currency =
        typeof account.currency === 'string'
          ? account.currency
          : account.currency.code;
      try {
        const txs = await this.signedGet<{ data: CoinbaseTransaction[] }>(
          `/v2/accounts/${account.id}/transactions`,
          credentials,
        );
        for (const tx of txs.data) {
          const timestamp = new Date(tx.created_at);
          if (since && timestamp < since) continue;
          const type = this.mapType(tx.type);
          if (!type) continue;
          const quantity = Math.abs(Number(tx.amount.amount));
          results.push({
            externalId: `tx-${tx.id}`,
            type,
            asset: currency,
            quantity: String(quantity),
            priceInQuote:
              type === TransactionType.BUY || type === TransactionType.SELL
                ? String(
                    Math.abs(Number(tx.native_amount.amount)) / (quantity || 1),
                  )
                : undefined,
            quoteCurrency:
              type === TransactionType.BUY || type === TransactionType.SELL
                ? tx.native_amount.currency
                : undefined,
            timestamp,
            raw: tx,
          });
        }
      } catch (err) {
        this.logger.warn(
          `Coinbase hesap ${account.id} işlemleri alınamadı: ${(err as Error).message}`,
        );
      }
    }
    return results;
  }

  private mapType(rawType: string): TransactionType | null {
    switch (rawType) {
      case 'buy':
        return TransactionType.BUY;
      case 'sell':
        return TransactionType.SELL;
      case 'send':
        return TransactionType.TRANSFER_OUT;
      case 'pro_deposit':
      case 'exchange_deposit':
        return TransactionType.DEPOSIT;
      case 'pro_withdrawal':
      case 'exchange_withdrawal':
        return TransactionType.WITHDRAWAL;
      case 'staking_reward':
        return TransactionType.STAKING_REWARD;
      case 'inflation_reward':
        return TransactionType.AIRDROP;
      default:
        return null; // fiat_deposit, request vb. — vergi acisindan ilgisiz turler atlanir
    }
  }

  private async signedGet<T>(
    path: string,
    credentials: ExchangeCredentials,
  ): Promise<T> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(timestamp + 'GET' + path)
      .digest('hex');

    const res = await fetch(`${REST_BASE}${path}`, {
      headers: {
        'CB-ACCESS-KEY': credentials.apiKey,
        'CB-ACCESS-SIGN': signature,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-VERSION': '2024-01-01',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Coinbase API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
