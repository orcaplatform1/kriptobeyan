import {
  ApiPermissionLevel,
  ExchangeProvider,
  TransactionType,
} from '../../../generated/prisma/client';

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  passphrase?: string; // OKX gibi bazı borsalar ister
}

export interface NormalizedExchangeTransaction {
  externalId: string;
  type: TransactionType;
  asset: string;
  quantity: string; // Decimal hassasiyeti icin string olarak tasiniyor
  priceInQuote?: string;
  quoteCurrency?: string;
  feeAmount?: string;
  feeAsset?: string;
  timestamp: Date;
  raw: unknown;
}

export interface ExchangeAdapter {
  readonly provider: ExchangeProvider;

  /**
   * Borsa API'si uzerinden bu key'in gercek izin seviyesini dogrular
   * (read-only mu, trade mi, withdraw mu). Borsa bunu desteklemiyorsa
   * ApiPermissionLevel.UNKNOWN doner.
   */
  verifyPermissionLevel(
    credentials: ExchangeCredentials,
  ): Promise<ApiPermissionLevel>;

  /**
   * Islem gecmisini normalize edilmis formatta getirir. `since` verilirse
   * sadece o tarihten sonrasi cekilir (artimli senkronizasyon).
   *
   * NOT: Cogu borsa spot islem gecmisini sembol bazinda dondurur, "tum
   * islemler" diye tek bir uc nokta yoktur — bu yuzden implementasyonlar
   * once hesap bakiyelerinden/varliklarindan olasi sembolleri cikarip
   * onlar uzerinde dolasir. Bu, pratikte GENELDE dogru sonuc verir ama
   * TEORIK olarak artik bakiyesi sifira dusmus (tamamen satilmis) bir
   * varligin cok eski islemlerini kacirabilir. Gercek kullaniciyla
   * dogrulanmasi onerilir.
   */
  fetchTransactions(
    credentials: ExchangeCredentials,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]>;
}
