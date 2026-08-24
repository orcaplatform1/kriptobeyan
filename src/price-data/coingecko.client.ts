import { Injectable, Logger } from '@nestjs/common';

const API_BASE = 'https://api.coingecko.com/api/v3';

// Sembol -> CoinGecko coin id eslemesi, sadece piyasa degerine gore ilk
// 250 coin'den turetiliyor (bkz. resolveId). Tum /coins/list'i (binlerce,
// cogu spam/olu coin ve sembol cakismasi) kullanmiyoruz — az bilinen bir
// coin icin fiyat bulunamayabilir, bu durumda kullaniciya net hata donulur.
@Injectable()
export class CoingeckoClient {
  private readonly logger = new Logger(CoingeckoClient.name);
  private symbolToId = new Map<string, string>();
  private symbolMapLoadedAt = 0;
  private readonly SYMBOL_MAP_TTL_MS = 12 * 3_600_000; // 12 saat

  private async ensureSymbolMap(): Promise<void> {
    if (
      Date.now() - this.symbolMapLoadedAt < this.SYMBOL_MAP_TTL_MS &&
      this.symbolToId.size > 0
    )
      return;
    const res = await fetch(
      `${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1`,
    );
    if (!res.ok) throw new Error(`CoinGecko markets hatası: ${res.status}`);
    const rows = (await res.json()) as { id: string; symbol: string }[];
    this.symbolToId = new Map(rows.map((r) => [r.symbol.toUpperCase(), r.id]));
    this.symbolMapLoadedAt = Date.now();
  }

  async resolveId(symbol: string): Promise<string | null> {
    await this.ensureSymbolMap();
    return this.symbolToId.get(symbol.toUpperCase()) ?? null;
  }

  /** date: DD-MM-YYYY (CoinGecko formatı) */
  async getHistoricalPrice(
    symbol: string,
    quoteCurrency: string,
    date: Date,
  ): Promise<number | null> {
    const coinId = await this.resolveId(symbol);
    if (!coinId) {
      this.logger.warn(
        `CoinGecko'da "${symbol}" için coin id bulunamadı (ilk 250'de yok)`,
      );
      return null;
    }
    const dateStr = `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
    const res = await fetch(
      `${API_BASE}/coins/${coinId}/history?date=${dateStr}&localization=false`,
    );
    if (!res.ok) {
      if (res.status === 429)
        throw new Error('CoinGecko rate limit — daha sonra tekrar dene');
      throw new Error(`CoinGecko history hatası: ${res.status}`);
    }
    const json = (await res.json()) as {
      market_data?: { current_price?: Record<string, number> };
    };
    const price =
      json.market_data?.current_price?.[quoteCurrency.toLowerCase()];
    return price ?? null;
  }
}
