import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ExchangeIntegrationService } from './exchange-integration.service';
import { WalletAddressService } from './wallet-address.service';

export interface SyncJobData {
  kind: 'exchange' | 'wallet';
  userId: string;
  id: string;
}

/**
 * Kullanicinin API anahtarini bagladigi/senkronize istedigi an veriyi ana
 * HTTP istegi icinde cekmiyoruz (borsa API'si 5 yillik veri icin yavas
 * olabilir, sayfalama + rate-limit backoff gerektirebilir — bkz. binance/
 * bybit adaptorleri) — bunun yerine Redis destekli BullMQ kuyruguna atip
 * arka planda bu worker'da isliyoruz (kullanicinin "asenkron sıralama"
 * istegi). Controller/service HEMEN doner, ExchangeConnection.syncStatus
 * SYNCING olarak isaretlenir, kullanici arayuzden (mevcut "senkronize
 * ediliyor…" durumu) takip eder.
 */
@Injectable()
@Processor('sync')
export class SyncProcessor extends WorkerHost {
  private readonly logger = new Logger(SyncProcessor.name);

  constructor(
    private readonly exchangeService: ExchangeIntegrationService,
    private readonly walletService: WalletAddressService,
  ) {
    super();
  }

  async process(job: Job<SyncJobData>): Promise<number> {
    const { kind, userId, id } = job.data;
    try {
      return kind === 'exchange'
        ? await this.exchangeService.performSync(userId, id)
        : await this.walletService.performSync(userId, id);
    } catch (err) {
      // syncStatus zaten ilgili performSync icinde ERROR'a cekildi —
      // burada sadece worker loguna dusuyor, BullMQ job'u FAILED isaretler.
      this.logger.warn(
        `Sync job basarisiz (${kind} ${id}): ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
