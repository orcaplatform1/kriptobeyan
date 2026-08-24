import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SpamFilterService } from '../spam-filter/spam-filter.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  TransactionSource,
  TransactionType,
  ReconciliationFlagType,
  Prisma,
} from '../../generated/prisma/client';
import type { NormalizedExchangeTransaction } from '../exchange-integration/adapters/exchange-adapter.interface';

// Ayni islemin iki farkli "yon"u (WITHDRAWAL/DEPOSIT veya TRANSFER_OUT/IN)
// bu pencere icinde eslesiyorsa kendi-hesaplar-arasi transfer sayilir.
const TRANSFER_MATCH_WINDOW_HOURS = 48;
// Miktarlar tam esit olmayabilir (ag ucreti dusulmus olabilir) — %1 tolerans.
const TRANSFER_AMOUNT_TOLERANCE = 0.01;

export interface IngestSourceRef {
  source: TransactionSource;
  exchangeConnectionId?: string;
  walletAddressId?: string;
  csvImportId?: string;
}

@Injectable()
export class TransactionAggregationService {
  private readonly logger = new Logger(TransactionAggregationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly spamFilter: SpamFilterService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Farkli kaynaklardan (borsa API, cuzdan, CSV) gelen normalize edilmis
   * islemleri tek `Transaction` tablosuna, dedupe ederek yazar. Ayni
   * (userId, source, externalId) zaten varsa atlanir (idempotent — ayni
   * senkronizasyon birden fazla calissa da cift kayit olusmaz).
   */
  async ingest(
    userId: string,
    ref: IngestSourceRef,
    items: NormalizedExchangeTransaction[],
  ): Promise<number> {
    let inserted = 0;
    for (const item of items) {
      const isSpam = await this.spamFilter.isSpam(item.asset);
      const taxYear = item.timestamp.getFullYear();
      try {
        await this.prisma.transaction.create({
          data: {
            userId,
            source: ref.source,
            exchangeConnectionId: ref.exchangeConnectionId,
            walletAddressId: ref.walletAddressId,
            csvImportId: ref.csvImportId,
            externalId: item.externalId,
            type: item.type,
            asset: item.asset,
            quantity: new Prisma.Decimal(item.quantity),
            priceInQuote: item.priceInQuote
              ? new Prisma.Decimal(item.priceInQuote)
              : undefined,
            quoteCurrency: item.quoteCurrency,
            feeAmount: item.feeAmount
              ? new Prisma.Decimal(item.feeAmount)
              : undefined,
            feeAsset: item.feeAsset,
            timestamp: item.timestamp,
            taxYear,
            isSpamFiltered: isSpam,
            rawData: item.raw as Prisma.InputJsonValue,
          },
        });
        inserted++;
      } catch (err) {
        // Unique(userId, source, externalId) ihlali = zaten var, sessizce atla.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== 'P2002'
        ) {
          this.logger.warn(
            `Islem kaydedilemedi (${item.externalId}): ${(err as Error).message}`,
          );
        }
      }
    }

    if (inserted > 0) {
      await this.detectInternalTransfers(userId);
      await this.reconcile(userId);
    }
    return inserted;
  }

  /**
   * ÖNCELİKLİ MANTIK: Kullanıcının kendi hesapları arasındaki transferleri
   * (ör. Binance'ten BtcTurk'e USDT göndermek) tespit edip isInternalTransfer
   * = true işaretler. Bu olmadan her iç transfer yanlışlıkla "elden çıkarma"
   * gibi görünüp şişirilmiş/hatalı kâr-zarar hesabına yol açar.
   *
   * Heuristik: aynı kullanıcının WITHDRAWAL/TRANSFER_OUT'u ile başka bir
   * kaynaktaki DEPOSIT/TRANSFER_IN'i — aynı varlık, ~aynı miktar (ağ ücreti
   * farkına tolerans), TRANSFER_MATCH_WINDOW_HOURS içinde — eşleşiyorsa
   * ikisi de iç transfer sayılır.
   */
  async detectInternalTransfers(userId: string): Promise<number> {
    const outgoing = await this.prisma.transaction.findMany({
      where: {
        userId,
        type: {
          in: [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT],
        },
        isInternalTransfer: false,
      },
    });
    const incoming = await this.prisma.transaction.findMany({
      where: {
        userId,
        type: { in: [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN] },
        isInternalTransfer: false,
      },
    });

    let matched = 0;
    const windowMs = TRANSFER_MATCH_WINDOW_HOURS * 3_600_000;
    const usedIncomingIds = new Set<string>();

    for (const out of outgoing) {
      const outQty = out.quantity.toNumber();
      const candidate = incoming.find((inc) => {
        if (usedIncomingIds.has(inc.id)) return false;
        if (inc.asset !== out.asset) return false;
        // Ayni kaynak (ayni borsa baglantisi) icindeyse zaten transfer degil,
        // farkli kaynaklar arasi olmali.
        const sameSource =
          (out.exchangeConnectionId &&
            out.exchangeConnectionId === inc.exchangeConnectionId) ||
          (out.walletAddressId && out.walletAddressId === inc.walletAddressId);
        if (sameSource) return false;
        const timeDiff = Math.abs(
          inc.timestamp.getTime() - out.timestamp.getTime(),
        );
        if (timeDiff > windowMs) return false;
        const incQty = inc.quantity.toNumber();
        const diff = Math.abs(incQty - outQty) / outQty;
        return diff <= TRANSFER_AMOUNT_TOLERANCE;
      });

      if (candidate) {
        usedIncomingIds.add(candidate.id);
        await this.prisma.transaction.updateMany({
          where: { id: { in: [out.id, candidate.id] } },
          data: { isInternalTransfer: true },
        });
        matched++;
      }
    }

    if (matched > 0) {
      this.logger.log(
        `Kullanıcı ${userId} için ${matched} iç transfer çifti tespit edildi`,
      );
    }
    return matched;
  }

  /**
   * Negatif bakiye / eksik veri şüphesi taraması. Kesin bir hesaplama
   * DEĞİL — TaxCalculationService FIFO ile ayrı ve daha kesin hesaplar;
   * burası sadece "bir şeyler eksik olabilir" uyarısı üretir.
   */
  async reconcile(userId: string): Promise<void> {
    const transactions = await this.prisma.transaction.findMany({
      where: { userId, isInternalTransfer: false, isSpamFiltered: false },
      orderBy: { timestamp: 'asc' },
    });

    const runningBalance = new Map<string, number>();
    for (const tx of transactions) {
      const qty = tx.quantity.toNumber();
      const current = runningBalance.get(tx.asset) ?? 0;
      const inflowTypes: TransactionType[] = [
        TransactionType.BUY,
        TransactionType.DEPOSIT,
        TransactionType.TRANSFER_IN,
        TransactionType.STAKING_REWARD,
        TransactionType.AIRDROP,
        TransactionType.MINING_REWARD,
        TransactionType.LP_REWARD,
      ];
      const isInflow = inflowTypes.includes(tx.type);
      const next = isInflow ? current + qty : current - qty;
      runningBalance.set(tx.asset, next);

      if (next < -1e-8) {
        const existing = await this.prisma.reconciliationFlag.findFirst({
          where: {
            userId,
            transactionId: tx.id,
            type: ReconciliationFlagType.NEGATIVE_BALANCE,
            resolved: false,
          },
        });
        if (!existing) {
          const description = `${tx.asset} bakiyesi ${tx.timestamp.toISOString()} tarihinde negatife düşüyor — muhtemelen eksik/senkronize edilmemiş bir alım/transfer var.`;
          await this.prisma.reconciliationFlag.create({
            data: {
              userId,
              transactionId: tx.id,
              type: ReconciliationFlagType.NEGATIVE_BALANCE,
              description,
            },
          });
          await this.notifications.flagDataIssue(userId, description);
        }
        // Negatif bakiyeyi 0'a sifirlayip devam ediyoruz ki tek bir eksik
        // kayit butun sonraki hesabi anlamsizca negatif gostermesin.
        runningBalance.set(tx.asset, 0);
      }
    }
  }

  async listForUser(userId: string, taxYear?: number) {
    return this.prisma.transaction.findMany({
      where: { userId, ...(taxYear ? { taxYear } : {}) },
      orderBy: { timestamp: 'desc' },
    });
  }
}
