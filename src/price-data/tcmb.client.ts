import { Injectable, Logger } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

interface TcmbCurrencyRow {
  '@_CurrencyCode': string;
  ForexBuying?: string;
}

interface TcmbXmlShape {
  Tarih_Date?: { Currency?: TcmbCurrencyRow | TcmbCurrencyRow[] };
}

// TCMB gunluk kur XML servisi — resmi, ucretsiz, API key gerektirmiyor.
// NOT: TCMB kur listesi hafta sonu/resmi tatil gunlerinde yayinlanmaz; boyle
// bir tarih icin en yakin ONCEKI is gununu deneriz (bkz. getRateWithFallback).
@Injectable()
export class TcmbClient {
  private readonly logger = new Logger(TcmbClient.name);
  private readonly parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  /** currencyCode ör. "USD" — TRY karşılığı döner (ForexBuying). */
  async getRate(currencyCode: string, date: Date): Promise<number | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = new Date(date);
      d.setUTCDate(d.getUTCDate() - attempt);
      const rate = await this.fetchRateForDate(currencyCode, d);
      if (rate != null) return rate;
    }
    return null;
  }

  private async fetchRateForDate(
    currencyCode: string,
    date: Date,
  ): Promise<number | null> {
    const yyyymm = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const ddmmyyyy = `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCMonth() + 1).padStart(2, '0')}${date.getUTCFullYear()}`;
    const url = `https://www.tcmb.gov.tr/kurlar/${yyyymm}/${ddmmyyyy}.xml`;

    const res = await fetch(url);
    if (!res.ok) return null; // o gun icin kur yayinlanmamis (hafta sonu/tatil)

    const xml = await res.text();
    try {
      const parsed = this.parser.parse(xml) as TcmbXmlShape;
      const currencies = parsed.Tarih_Date?.Currency;
      const list = Array.isArray(currencies)
        ? currencies
        : currencies
          ? [currencies]
          : [];
      const match = list.find((c) => c['@_CurrencyCode'] === currencyCode);
      const value = match?.ForexBuying;
      if (value == null || value === '') return null;
      return parseFloat(value);
    } catch (err) {
      this.logger.warn(
        `TCMB XML ayrıştırma hatası (${url}): ${(err as Error).message}`,
      );
      return null;
    }
  }
}
