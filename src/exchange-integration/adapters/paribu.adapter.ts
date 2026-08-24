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

// Paribu'nun resmi API dokumantasyonu (docs.paribu.com/api) — Binance/OKX/
// Bybit'ten FARKLI bir imzalama semasi kullanir: query-string tabanli
// signature parametresi degil, HTTP header'lari (Authorization/X-Signature/
// X-Timestamp) uzerinden. Bkz. authentication-and-signing sayfasi.
const REST_BASE = 'https://api.paribu.com';

const TRADES_PAGE_SIZE = 100; // dokumantasyonda belirtilen max per_page
const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;

interface ParibuTrade {
  orderId: string;
  userId: string;
  direction: 'buy' | 'sell';
  marketCurrency: string;
  paymentCurrency: string;
  price: string;
  amount: string;
  commission: string;
  role: 'MAKER' | 'TAKER' | 'UNKNOWN';
  createdAt: string; // RFC3339 UTC
}

interface ParibuTradesResponse {
  paging: { page: number; pageSize: number };
  trades: ParibuTrade[];
}

interface ParibuTransfer {
  id: string;
  type: 'deposit' | 'withdraw';
  symbol: string;
  amount: string;
  status: string;
  created_at: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateParam(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * NOT: Bu adaptor Paribu'nun resmi API dokumantasyonuna (docs.paribu.com/api)
 * gore yazildi ancak gercek, kimlikli bir hesaba karsi TEST EDILMEDI.
 * Iki onemli belirsizlik var:
 *  1) /trades/history yanitindaki "commission" hangi para biriminde
 *     kesiliyor, dokumantasyonda ayri bir alan olarak belirtilmemis —
 *     feeAsset bu yuzden bos birakildi.
 *  2) Paribu'nun API key izin/scope'larini SORGULAYAN bir uc noktasi
 *     dokumante edilmemis (bkz. scopes-and-permissions sayfasi) — bu
 *     yuzden verifyPermissionLevel gercek izin seviyesini (ozellikle
 *     WITHDRAW) tespit EDEMEZ, sadece anahtarin okuma icin gecerli olup
 *     olmadigini dogrular ve READ_ONLY/UNKNOWN doner. Diger adaptorlerin
 *     aksine burada WITHDRAW tespiti YOK — bu bilinen bir sinirlama.
 * Uretime almadan once gercek bir hesapla dogrulanmali.
 */
@Injectable()
export class ParibuAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.PARIBU;
  private readonly logger = new Logger(ParibuAdapter.name);

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      await this.signedGet('/user/assets', {}, credentials);
      // Paribu'da izin/scope introspeksiyonu icin dokumante edilmis bir uc
      // nokta yok — WITHDRAW/TRADE izinlerini ayirt edemiyoruz (bkz. sinif
      // yorumu). Anahtar gecerliyse temkinli sekilde READ_ONLY donuyoruz.
      return ApiPermissionLevel.READ_ONLY;
    } catch (err) {
      this.logger.warn(
        `Paribu izin dogrulama basarisiz: ${(err as Error).message}`,
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

    results.push(...(await this.fetchTransfers(credentials, startTime)));
    results.push(...(await this.fetchTrades(credentials, startTime)));

    return results;
  }

  /** /transfers/history hem deposit hem withdraw kayitlarini "type" alaniyla
   *  ayirt edilmis tek listede donuyor (bkz. sinif yorumu). */
  private async fetchTransfers(credentials: ExchangeCredentials, startTime: number) {
    const res = await this.signedGet<{ transfers?: ParibuTransfer[] } | ParibuTransfer[]>(
      '/transfers/history',
      { begin_date: toDateParam(startTime), end_date: toDateParam(Date.now()) },
      credentials,
    );
    const rows: ParibuTransfer[] = Array.isArray(res) ? res : (res.transfers ?? []);

    return rows
      .filter((r) => r.type === 'deposit' || r.type === 'withdraw')
      .map((r): NormalizedExchangeTransaction => ({
        externalId: `${r.type}-${r.id}`,
        type: r.type === 'deposit' ? TransactionType.DEPOSIT : TransactionType.WITHDRAWAL,
        asset: r.symbol,
        quantity: String(r.amount),
        timestamp: new Date(r.created_at),
        raw: r,
      }));
  }

  /** Binance/Bybit'in aksine Paribu tum piyasalari TEK cagriyla dondurur —
   *  varlik/sembol bazinda dolasmaya gerek yok (filter_market atlaniyor). */
  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const results: NormalizedExchangeTransaction[] = [];
    let page = 1;

    for (;;) {
      const res = await this.signedGet<ParibuTradesResponse>(
        '/trades/history',
        {
          begin_date: toDateParam(startTime),
          end_date: toDateParam(Date.now()),
          page,
          per_page: TRADES_PAGE_SIZE,
        },
        credentials,
      );
      const trades = res.trades ?? [];
      for (const t of trades) {
        results.push({
          externalId: `trade-${t.orderId}-${t.createdAt}`,
          type: t.direction === 'buy' ? TransactionType.BUY : TransactionType.SELL,
          asset: t.marketCurrency,
          quantity: String(t.amount),
          priceInQuote: String(t.price),
          quoteCurrency: t.paymentCurrency,
          feeAmount: t.commission !== undefined ? String(t.commission) : undefined,
          timestamp: new Date(t.createdAt),
          raw: t,
        });
      }
      if (trades.length < TRADES_PAGE_SIZE) break;
      page += 1;
    }
    return results;
  }

  private async signedGet<T>(
    path: string,
    params: Record<string, string | number>,
    credentials: ExchangeCredentials,
    attempt = 0,
  ): Promise<T> {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    ).toString();
    const timestamp = String(Date.now());
    // Imza payload'i: timestamp + query-string (basinda '?' olmadan) +
    // body (GET icin bos) — sirali, ayiracsiz concat (bkz. dokumantasyon).
    const payload = `${timestamp}${query}`;
    const signature = createHmac('sha256', credentials.apiSecret)
      .update(payload)
      .digest('base64');

    const url = `${REST_BASE}${path}${query ? `?${query}` : ''}`;
    const res = await fetch(url, {
      headers: {
        Authorization: credentials.apiKey,
        'X-Signature': signature,
        'X-Timestamp': timestamp,
      },
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const delay = retryAfterHeader
        ? Number(retryAfterHeader) * 1000
        : RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `Paribu 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Paribu API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
