import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceDataService } from '../price-data/price-data.service';

export interface LossHarvestingOpportunity {
  asset: string;
  totalQuantity: number;
  totalCostBasisTRY: number;
  currentValueTRY: number;
  unrealizedLossTRY: number; // pozitif sayı = zarar buyuklugu
  currentPriceTRY: number;
  lotCount: number;
}

/**
 * Kullanıcının hâlâ elinde tuttuğu (TaxLot.remainingQuantity > 0), değer
 * kaybetmiş coin'leri tespit edip "bunu satarsan şu kadar zarar mahsup
 * edebilirsin" simülasyonu sunar. Gerçek bir satış İŞLEMİ YAPMAZ — sadece
 * hesaplama. TaxCalculationService'in FIFO lot'larını temel alır, bu yüzden
 * güncel olması için önce tax-calculation/:taxYear/calculate çalıştırılmış
 * olmalı (lot'lar oradan gelir).
 */
@Injectable()
export class TaxLossHarvestingService {
  private readonly logger = new Logger(TaxLossHarvestingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceData: PriceDataService,
  ) {}

  async getOpportunities(userId: string): Promise<LossHarvestingOpportunity[]> {
    const lots = await this.prisma.taxLot.findMany({
      where: { userId, remainingQuantity: { gt: 0 } },
    });

    const byAsset = new Map<string, typeof lots>();
    for (const lot of lots) {
      const list = byAsset.get(lot.asset) ?? [];
      list.push(lot);
      byAsset.set(lot.asset, list);
    }

    const opportunities: LossHarvestingOpportunity[] = [];
    const today = new Date();

    for (const [asset, assetLots] of byAsset) {
      const currentPrice = await this.priceData.getPrice(asset, 'TRY', today);
      if (currentPrice == null) {
        this.logger.warn(
          `${asset} için güncel fiyat bulunamadı, loss harvesting hesabı atlandı`,
        );
        continue;
      }

      let totalQuantity = 0;
      let totalCostBasisTRY = 0;
      for (const lot of assetLots) {
        const qty = lot.remainingQuantity.toNumber();
        totalQuantity += qty;
        totalCostBasisTRY += qty * lot.costBasisPerUnitTRY.toNumber();
      }

      const currentValueTRY = totalQuantity * currentPrice;
      const unrealizedLossTRY = totalCostBasisTRY - currentValueTRY;

      // Sadece gerçekten zararda olanlar "firsat" sayilir.
      if (unrealizedLossTRY > 0) {
        opportunities.push({
          asset,
          totalQuantity,
          totalCostBasisTRY,
          currentValueTRY,
          unrealizedLossTRY,
          currentPriceTRY: currentPrice,
          lotCount: assetLots.length,
        });
      }
    }

    return opportunities.sort(
      (a, b) => b.unrealizedLossTRY - a.unrealizedLossTRY,
    );
  }
}
