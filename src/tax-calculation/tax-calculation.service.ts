import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceDataService } from '../price-data/price-data.service';
import { TransactionType, Prisma } from '../../generated/prisma/client';
import { getTurkeyYear } from '../common/turkey-date.util';

// Bu asset'lerin donus degeri kabul edilir (fiat/stabil), FIFO lot olarak
// izlenmez — sadece TRY donusumu icin kullanilir.
const FIAT_LIKE = new Set(['TRY']);

const ACQUISITION_TYPES = new Set<TransactionType>([
  TransactionType.BUY,
  TransactionType.DEPOSIT,
  TransactionType.TRANSFER_IN,
  TransactionType.STAKING_REWARD,
  TransactionType.AIRDROP,
  TransactionType.MINING_REWARD,
]);

// SADECE bunlar gercek "elden cikarma" (taxable disposal) sayilir.
// WITHDRAWAL/TRANSFER_OUT (esletirilmemis) bilerek disarida birakildi —
// bkz. asagidaki uzun yorum.
const DISPOSAL_TYPES = new Set<TransactionType>([TransactionType.SELL]);

// Yalnizca lot azaltan ama gercek bir elden cikarma OLMAYAN turler —
// bakiye/lot takibini tutarli tutmak icin FIFO'dan sessizce dusuluyor,
// kazanc/zarar hesabina KATILMIYOR.
const SILENT_CONSUMPTION_TYPES = new Set<TransactionType>([
  TransactionType.WITHDRAWAL,
  TransactionType.TRANSFER_OUT,
  TransactionType.FEE,
]);

const OCCASIONAL_INCOME_TYPES = new Set<TransactionType>([
  TransactionType.STAKING_REWARD,
  TransactionType.AIRDROP,
  TransactionType.MINING_REWARD,
]);

interface WorkingLot {
  id: string;
  remainingQuantity: number;
  costBasisPerUnitTRY: number;
  acquisitionDate: Date;
}

/**
 * ============================================================
 * TASLAK/TAHMİNİ HESAPLAMA — bu modülün mantığı bir mali müşavirle
 * doğrulanana kadar kesin rakam gibi kullanıcıya sunulmamalı. Her
 * TaxYearSummary.isDraft = true olarak işaretlenir, UI'da bunu net
 * göstermek zorunlu.
 * ============================================================
 *
 * TASARIM KARARI (kritik, dikkatlice okunmalı): WITHDRAWAL/TRANSFER_OUT
 * işlemleri (kendi hesapları arasında transfer olarak eşleştirilmemişse)
 * FIFO'dan lot düşer ama kazanç/zarar ÜRETMEZ. Sebep: bir kullanıcı
 * kripto parasını kendi soğuk cüzdanına (henüz sisteme eklenmemiş bir
 * adrese) çekebilir — bu bir satış değildir. Her eşleşmemiş çekimi
 * "piyasa fiyatından satış" sayıp vergi hesaplamak, gerçek satışlardan
 * çok daha yaygın olan bu senaryoda YANLIŞ ve ŞİŞİRİLMİŞ bir kazanç
 * üretir — bu, "eksik/yanlış az vergi" hesaplamaktan daha kötü bir hata
 * sınıfıdır. Bunun yerine ReconciliationFlag ve dashboard, kullanıcıyı
 * eşleşmemiş çekimleri gözden geçirmeye / eksik cüzdanı eklemeye
 * yönlendirmeli.
 */
@Injectable()
export class TaxCalculationService {
  private readonly logger = new Logger(TaxCalculationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceData: PriceDataService,
  ) {}

  /**
   * Kullanıcının TÜM geçmişini (sadece hedef yılı değil) baştan işleyip
   * TaxLot'ları yeniden kurar — bir coin önceki yılda alınıp bu yıl
   * satılmış olabilir, FIFO doğruluğu için bu şart. Sonra hedef yılın
   * TaxYearSummary'sini hesaplar.
   */
  async calculateForYear(userId: string, taxYear: number) {
    const transactions = await this.prisma.transaction.findMany({
      where: { userId, isInternalTransfer: false, isSpamFiltered: false },
      orderBy: { timestamp: 'asc' },
    });

    // Onceki calistirmadan kalan lot'lari temizleyip sifirdan kur —
    // idempotent, tutarli bir "tam yeniden hesaplama" garantisi.
    await this.prisma.taxLot.deleteMany({ where: { userId } });

    const lotsByAsset = new Map<string, WorkingLot[]>();
    const yearlyGains = new Map<number, number>();
    const yearlyLosses = new Map<number, number>();
    const yearlyOccasionalIncome = new Map<number, number>();

    for (const tx of transactions) {
      const asset = tx.asset.toUpperCase();
      if (FIAT_LIKE.has(asset)) continue;
      const txYear = getTurkeyYear(tx.timestamp);
      const quantity = tx.quantity.toNumber();

      if (ACQUISITION_TYPES.has(tx.type)) {
        const costBasisTotal = await this.resolveValueInTRY(tx);
        if (costBasisTotal == null) {
          this.logger.warn(
            `Fiyat bulunamadığı için maliyet 0 kabul edildi: tx=${tx.id} ${asset} @ ${tx.timestamp.toISOString()}`,
          );
        }
        const costBasisPerUnit =
          costBasisTotal != null ? costBasisTotal / quantity : 0;

        const lot = await this.prisma.taxLot.create({
          data: {
            userId,
            asset,
            originalQuantity: tx.quantity,
            remainingQuantity: tx.quantity,
            costBasisPerUnitTRY: new Prisma.Decimal(costBasisPerUnit),
            acquisitionDate: tx.timestamp,
            acquisitionTransactionId: tx.id,
            taxYear: txYear,
          },
        });
        const list = lotsByAsset.get(asset) ?? [];
        list.push({
          id: lot.id,
          remainingQuantity: quantity,
          costBasisPerUnitTRY: costBasisPerUnit,
          acquisitionDate: tx.timestamp,
        });
        list.sort(
          (a, b) => a.acquisitionDate.getTime() - b.acquisitionDate.getTime(),
        );
        lotsByAsset.set(asset, list);

        if (OCCASIONAL_INCOME_TYPES.has(tx.type) && costBasisTotal != null) {
          yearlyOccasionalIncome.set(
            txYear,
            (yearlyOccasionalIncome.get(txYear) ?? 0) + costBasisTotal,
          );
        }
        continue;
      }

      if (
        DISPOSAL_TYPES.has(tx.type) ||
        SILENT_CONSUMPTION_TYPES.has(tx.type)
      ) {
        const lots = lotsByAsset.get(asset) ?? [];
        let remaining = quantity;
        let totalCostBasis = 0;

        while (remaining > 1e-12 && lots.length > 0) {
          const lot = lots[0];
          const consume = Math.min(remaining, lot.remainingQuantity);
          totalCostBasis += consume * lot.costBasisPerUnitTRY;
          lot.remainingQuantity -= consume;
          remaining -= consume;
          if (lot.remainingQuantity <= 1e-12) {
            lots.shift();
            await this.prisma.taxLot.update({
              where: { id: lot.id },
              data: { remainingQuantity: 0, fullyConsumed: true },
            });
          } else {
            await this.prisma.taxLot.update({
              where: { id: lot.id },
              data: { remainingQuantity: lot.remainingQuantity },
            });
          }
        }

        if (remaining > 1e-12) {
          // Elde yeterli lot yok — muhtemelen eksik/senkronize edilmemis bir
          // alim var (TransactionAggregationService.reconcile bunu zaten
          // NEGATIVE_BALANCE olarak isaretlemis olmali). Kalan kismin
          // maliyetini 0 kabul ediyoruz (en kotu durumda kullanicinin
          // aleyhine degil, KENDI lehine — daha az degil daha COK kazanc
          // gorunur ki eksik veriyi fark etsin).
        }

        if (DISPOSAL_TYPES.has(tx.type)) {
          const proceeds = await this.resolveValueInTRY(tx);
          if (proceeds != null) {
            const gainLoss = proceeds - totalCostBasis;
            if (gainLoss >= 0) {
              yearlyGains.set(
                txYear,
                (yearlyGains.get(txYear) ?? 0) + gainLoss,
              );
            } else {
              yearlyLosses.set(
                txYear,
                (yearlyLosses.get(txYear) ?? 0) + Math.abs(gainLoss),
              );
            }
          }
        }
      }
    }

    return this.persistSummary(userId, taxYear, {
      gain: yearlyGains.get(taxYear) ?? 0,
      loss: yearlyLosses.get(taxYear) ?? 0,
      occasionalIncome: yearlyOccasionalIncome.get(taxYear) ?? 0,
    });
  }

  private async resolveValueInTRY(tx: {
    asset: string;
    quantity: Prisma.Decimal;
    priceInQuote: Prisma.Decimal | null;
    quoteCurrency: string | null;
    timestamp: Date;
  }): Promise<number | null> {
    const quantity = tx.quantity.toNumber();
    if (tx.priceInQuote && tx.quoteCurrency) {
      const amountInQuote = quantity * tx.priceInQuote.toNumber();
      return this.priceData.convertAmountToTRY(
        amountInQuote,
        tx.quoteCurrency,
        tx.timestamp,
      );
    }
    // Islemde acik fiyat yoksa (ör. DEPOSIT/AIRDROP) o gunku piyasa
    // fiyatindan tahmini deger hesapla.
    return this.priceData.convertToTRY(tx.asset, quantity, 'TRY', tx.timestamp);
  }

  private async persistSummary(
    userId: string,
    taxYear: number,
    values: { gain: number; loss: number; occasionalIncome: number },
  ) {
    const exemptionConfig = await this.prisma.taxExemptionConfig.findUnique({
      where: { taxYear },
    });
    const capitalGainsExemption =
      exemptionConfig?.capitalGainsExemptionTRY.toNumber() ?? 0;
    const occasionalIncomeExemption =
      exemptionConfig?.occasionalIncomeExemptionTRY.toNumber() ?? 0;
    if (!exemptionConfig) {
      this.logger.warn(
        `${taxYear} için TaxExemptionConfig tanımlı değil — istisna 0 kabul edildi (admin eklemeli)`,
      );
    }

    const netCapitalGain = values.gain - values.loss;
    const capitalGainsExemptionUsed =
      netCapitalGain > 0 ? Math.min(netCapitalGain, capitalGainsExemption) : 0;
    const occasionalIncomeExemptionUsed = Math.min(
      values.occasionalIncome,
      occasionalIncomeExemption,
    );

    const taxableCapitalGain = Math.max(
      0,
      netCapitalGain - capitalGainsExemptionUsed,
    );
    const taxableOccasionalIncome = Math.max(
      0,
      values.occasionalIncome - occasionalIncomeExemptionUsed,
    );

    return this.prisma.taxYearSummary.upsert({
      where: { userId_taxYear: { userId, taxYear } },
      update: {
        totalRealizedGainTRY: values.gain,
        totalRealizedLossTRY: values.loss,
        netCapitalGainTRY: netCapitalGain,
        occasionalIncomeTRY: values.occasionalIncome,
        capitalGainsExemptionUsedTRY: capitalGainsExemptionUsed,
        occasionalIncomeExemptionUsedTRY: occasionalIncomeExemptionUsed,
        estimatedTaxableAmountTRY: taxableCapitalGain + taxableOccasionalIncome,
        isDraft: true,
        calculatedAt: new Date(),
      },
      create: {
        userId,
        taxYear,
        totalRealizedGainTRY: values.gain,
        totalRealizedLossTRY: values.loss,
        netCapitalGainTRY: netCapitalGain,
        occasionalIncomeTRY: values.occasionalIncome,
        capitalGainsExemptionUsedTRY: capitalGainsExemptionUsed,
        occasionalIncomeExemptionUsedTRY: occasionalIncomeExemptionUsed,
        estimatedTaxableAmountTRY: taxableCapitalGain + taxableOccasionalIncome,
        isDraft: true,
      },
    });
  }

  async getSummary(userId: string, taxYear: number) {
    return this.prisma.taxYearSummary.findUnique({
      where: { userId_taxYear: { userId, taxYear } },
    });
  }
}
