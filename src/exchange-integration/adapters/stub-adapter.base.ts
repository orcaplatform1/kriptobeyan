import { NotImplementedException } from '@nestjs/common';
import {
  ApiPermissionLevel,
  ExchangeProvider,
} from '../../../generated/prisma/client';
import type {
  ExchangeAdapter,
  ExchangeCredentials,
  NormalizedExchangeTransaction,
} from './exchange-adapter.interface';

/**
 * Guvenilir, yayinlanmis API dokumantasyonu teyit edilmeden gercek bir
 * entegrasyon yazilmadigi borsalar icin ortak stub taban sinifi (bkz.
 * ParibuAdapter'daki ayni gerekce). CSV import ile manuel yukleme her zaman
 * kullanilabilir.
 */
export abstract class StubExchangeAdapter implements ExchangeAdapter {
  abstract readonly provider: ExchangeProvider;
  protected abstract readonly displayName: string;

  verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel> {
    void credentials;
    return Promise.resolve(ApiPermissionLevel.UNKNOWN);
  }

  fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    void credentials;
    void since;
    throw new NotImplementedException(
      `${this.displayName} entegrasyonu henüz tamamlanmadı — API dokümantasyonu teyit edilmeden gerçek işlem verisi ` +
        'çekilmiyor. Şimdilik CSV import ile manuel yükleme kullanılabilir.',
    );
  }
}
