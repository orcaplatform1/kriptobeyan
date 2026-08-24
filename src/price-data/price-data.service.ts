import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CoingeckoClient } from './coingecko.client';
import { TcmbClient } from './tcmb.client';
import { PriceSource } from '../../generated/prisma/client';
import { toTurkeyDate } from '../common/turkey-date.util';

// Borsalardan gelen ham zaman damgalari UTC'dir; fiyat/kur onbellegi ve
// CoinGecko gunluk fiyat sorgusu TURKIYE takvim gunune gore anahtarlanmali
// (TSI = UTC+3, DST yok) — aksi halde ör. 22:00-23:59 UTC'deki bir islem
// (Turkiye'de zaten ertesi gunun 01:00-02:59'u) bir onceki gunun fiyatiyla
// eslesir (bkz. TcmbClient.getRate'deki ayni duzeltme).
function toDateOnly(date: Date): Date {
  const turkeyDate = toTurkeyDate(date);
  return new Date(
    Date.UTC(
      turkeyDate.getUTCFullYear(),
      turkeyDate.getUTCMonth(),
      turkeyDate.getUTCDate(),
    ),
  );
}

@Injectable()
export class PriceDataService {
  private readonly logger = new Logger(PriceDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly coingecko: CoingeckoClient,
    private readonly tcmb: TcmbClient,
  ) {}

  /**
   * asset/quoteCurrency ikilisi icin gunluk fiyat — once cache, yoksa
   * kaynaktan cekip cache'ler. USD/TRY icin TCMB, digerleri icin CoinGecko.
   */
  async getPrice(
    asset: string,
    quoteCurrency: string,
    date: Date,
  ): Promise<number | null> {
    const day = toDateOnly(date);
    const cached = await this.prisma.priceCache.findUnique({
      where: {
        asset_quoteCurrency_date: {
          asset: asset.toUpperCase(),
          quoteCurrency: quoteCurrency.toUpperCase(),
          date: day,
        },
      },
    });
    if (cached) return cached.price.toNumber();

    const isTcmbRate =
      asset.toUpperCase() === 'USD' && quoteCurrency.toUpperCase() === 'TRY';
    let price: number | null;
    let source: PriceSource;

    if (isTcmbRate) {
      price = await this.tcmb.getRate('USD', day);
      source = PriceSource.TCMB;
    } else {
      price = await this.coingecko.getHistoricalPrice(
        asset,
        quoteCurrency,
        day,
      );
      source = PriceSource.COINGECKO;
    }

    if (price == null) {
      this.logger.warn(
        `Fiyat bulunamadı: ${asset}/${quoteCurrency} @ ${day.toISOString().slice(0, 10)}`,
      );
      return null;
    }

    await this.prisma.priceCache
      .create({
        data: {
          asset: asset.toUpperCase(),
          quoteCurrency: quoteCurrency.toUpperCase(),
          date: day,
          price,
          source,
        },
      })
      .catch(() => undefined); // yarış durumunda unique çakışmasını yut

    return price;
  }

  /**
   * Herhangi bir coin/miktarı TRY karşılığına çevirir. quoteCurrency USD
   * ise CoinGecko'dan coin/USD fiyatı + TCMB'den USD/TRY kuru çarpılır
   * (kullanıcının açıkça belirttiği ask: "USD/USDT işlemlerini işlem
   * tarihindeki resmi TCMB kuru ile TL'ye çevir").
   */
  async convertToTRY(
    asset: string,
    quantity: number,
    quoteCurrency: string,
    date: Date,
  ): Promise<number | null> {
    if (quoteCurrency.toUpperCase() === 'TRY') {
      const price = await this.getPrice(asset, 'TRY', date);
      return price != null ? price * quantity : null;
    }

    // USDT'yi USD ile esdeger kabul ediyoruz (yaygin, pratik varsayim).
    const normalizedQuote =
      quoteCurrency.toUpperCase() === 'USDT'
        ? 'USD'
        : quoteCurrency.toUpperCase();
    const priceInQuote =
      normalizedQuote === 'USD' && asset.toUpperCase() === 'USD'
        ? 1
        : await this.getPrice(asset, normalizedQuote, date);
    if (priceInQuote == null) return null;

    const usdToTry = await this.tcmb.getRate('USD', date);
    if (usdToTry == null) return null;

    return priceInQuote * quantity * usdToTry;
  }

  /**
   * Zaten bilinen bir tutari (ör. bir islemin gerceklestigi fiyattan
   * hesaplanmis "quantity * priceInQuote") baska bir para biriminden TRY'ye
   * cevirir — convertToTRY'den farkli olarak coin'in piyasa fiyatini
   * YENIDEN CEKMEZ, sadece kur donusumu yapar (islemin gercek fiyati zaten
   * biliniyorsa gunluk piyasa kapanisini kullanmak yanlis/yaklasik olurdu).
   */
  async convertAmountToTRY(
    amount: number,
    fromCurrency: string,
    date: Date,
  ): Promise<number | null> {
    const currency = fromCurrency.toUpperCase();
    if (currency === 'TRY') return amount;
    const normalized =
      currency === 'USDT' || currency === 'USDC' ? 'USD' : currency;
    if (normalized === 'USD') {
      const rate = await this.tcmb.getRate('USD', date);
      return rate != null ? amount * rate : null;
    }
    // TRY/USD disi bir quote (baska bir coin uzerinden fiyatlanmis islem) —
    // once o coin'in TRY karsiligini bul.
    const price = await this.getPrice(normalized, 'TRY', date);
    return price != null ? price * amount : null;
  }
}
