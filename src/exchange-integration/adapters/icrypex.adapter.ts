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

// Kaynak: https://github.com/icrypex-com/apidoc (ICRYPEX'in resmi API
// dokumantasyon deposu). Public uc noktalar /v1/... altinda, kimlik
// dogrulamali (SIGNED) uc noktalar /sapi/v1/... altinda.
const REST_BASE = 'https://api.icrypex.com';

const DEFAULT_LOOKBACK_MS = 3 * 365 * 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 100;
const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 5000;
// ICX-NONCE: sunucu-istemci saat farki toleransi (ms). Dokumana gore max 60000.
const NONCE_TOLERANCE_MS = '60000';

interface IcrypexPair {
  symbol: string;
  base: string;
  quote: string;
}

interface IcrypexExchangeInfo {
  pairs: IcrypexPair[];
}

interface IcrypexPaginated<T> {
  items: T[];
  hasNextPage: boolean;
}

interface IcrypexTrade {
  date: number; // unix SANIYE (ms degil)
  orderId: number;
  pairSymbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  total: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * NOT: Bu adaptor ICRYPEX'in resmi, herkese acik API dokumantasyon
 * deposuna (github.com/icrypex-com/apidoc) gore yazildi ancak gercek,
 * kimlikli bir hesaba karsi TEST EDILMEDI. Uretime almadan once gercek
 * bir hesapla dogrulanmali.
 *
 * ICRYPEX API'sinde deposit/withdrawal gecmisi uc noktalari dokumantasyonda
 * acikca "This feature is not enabled yet" olarak isaretli (bkz. funding.md)
 * — yani bu borsadan su an SADECE islem (trade) gecmisi cekilebiliyor,
 * yatirma/cekme gecmisi API uzerinden mumkun degil. Durustluk ilkesi
 * geregi bu adaptor sadece trade donduruyor, uydurma veri uretmiyoruz.
 */
@Injectable()
export class IcrypexAdapter implements ExchangeAdapter {
  readonly provider = ExchangeProvider.ICRYPEX;
  private readonly logger = new Logger(IcrypexAdapter.name);
  private pairInfoCache: Map<string, { base: string; quote: string }> | null = null;

  async verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    try {
      // ICRYPEX dokumantasyonunda izin seviyesini (read/trade/withdraw)
      // dogrudan sorgulayan bir uc nokta yok. Auth basariliysa dogrulanmis
      // sayiyoruz ama seviyeyi ayirt edemiyoruz — para cekme zaten platform
      // genelinde API'den kapali (bkz. yukaridaki not), o risk su an yok.
      await this.signedGet<unknown>('/sapi/v1/wallet', {}, credentials);
      return ApiPermissionLevel.UNKNOWN;
    } catch (err) {
      this.logger.warn(
        `ICRYPEX izin dogrulama basarisiz: ${(err as Error).message}`,
      );
      return ApiPermissionLevel.UNKNOWN;
    }
  }

  async fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const startTime = since?.getTime() ?? Date.now() - DEFAULT_LOOKBACK_MS;
    return this.fetchTrades(credentials, startTime);
  }

  private async getPairInfo(): Promise<Map<string, { base: string; quote: string }>> {
    if (this.pairInfoCache) return this.pairInfoCache;
    const res = await fetch(`${REST_BASE}/v1/exchange/info`);
    if (!res.ok) {
      throw new Error(`ICRYPEX exchange/info hatası: ${res.status}`);
    }
    const info = (await res.json()) as IcrypexExchangeInfo;
    const map = new Map<string, { base: string; quote: string }>();
    for (const pair of info.pairs ?? []) {
      map.set(pair.symbol, { base: pair.base, quote: pair.quote });
    }
    this.pairInfoCache = map;
    return map;
  }

  private async fetchTrades(credentials: ExchangeCredentials, startTime: number) {
    const pairInfo = await this.getPairInfo();
    const results: NormalizedExchangeTransaction[] = [];
    const fromSec = Math.floor(startTime / 1000);
    const toSec = Math.floor(Date.now() / 1000);

    let page = 1;
    for (;;) {
      const res = await this.signedGet<IcrypexPaginated<IcrypexTrade>>(
        '/sapi/v1/trades',
        { from: fromSec, to: toSec, page, limit: PAGE_LIMIT },
        credentials,
      );
      for (const t of res.items ?? []) {
        const pair = pairInfo.get(t.pairSymbol);
        const asset = pair?.base ?? t.pairSymbol;
        const quote = pair?.quote ?? '';
        results.push({
          externalId: `trade-${t.orderId}-${t.date}`,
          type: t.side === 'BUY' ? TransactionType.BUY : TransactionType.SELL,
          asset,
          quantity: t.quantity,
          priceInQuote: t.price,
          quoteCurrency: quote,
          feeAmount: t.fee,
          // Dokumana gore: alis islemlerinde komisyon taban varlikta,
          // satis islemlerinde kotasyon varlikta kesiliyor.
          feeAsset: t.side === 'BUY' ? asset : quote,
          timestamp: new Date(t.date * 1000),
          raw: t,
        });
      }
      if (!res.hasNextPage) break;
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
    const ts = Date.now();
    // Imza SADECE apiKey+timestamp uzerinden hesaplaniyor (query/body dahil
    // degil) — bkz. architecture.md ornek kod (Python/PHP/C#).
    const secretKey = Buffer.from(credentials.apiSecret, 'base64');
    const signature = createHmac('sha256', secretKey)
      .update(`${credentials.apiKey}${ts}`)
      .digest('base64');

    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    );
    const qs = query.toString();
    const res = await fetch(`${REST_BASE}${path}${qs ? `?${qs}` : ''}`, {
      headers: {
        'ICX-API-KEY': credentials.apiKey,
        'ICX-SIGN': signature,
        'ICX-TS': String(ts),
        'ICX-NONCE': NONCE_TOLERANCE_MS,
      },
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        `ICRYPEX 429 — ${delay}ms sonra tekrar denenecek (deneme ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(delay);
      return this.signedGet<T>(path, params, credentials, attempt + 1);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ICRYPEX API hatası (${path}): ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
