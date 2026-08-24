import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PriceDataService } from '../price-data/price-data.service';

export interface PositionView {
  asset: string;
  quantity: number;
  costBasisTRY: number;
  currentValueTRY: number | null;
  unrealizedPnlTRY: number | null;
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly priceData: PriceDataService,
  ) {}

  /** Gerçekleşen kâr/zarar + istisna kullanım göstergesi — TaxYearSummary'den. */
  async getRealizedOverview(userId: string, taxYear: number) {
    const [summary, exemptionConfig] = await Promise.all([
      this.prisma.taxYearSummary.findUnique({
        where: { userId_taxYear: { userId, taxYear } },
      }),
      this.prisma.taxExemptionConfig.findUnique({ where: { taxYear } }),
    ]);

    const capitalGainsExemptionTotal =
      exemptionConfig?.capitalGainsExemptionTRY.toNumber() ?? null;
    const occasionalIncomeExemptionTotal =
      exemptionConfig?.occasionalIncomeExemptionTRY.toNumber() ?? null;
    const capitalGainsExemptionUsed =
      summary?.capitalGainsExemptionUsedTRY.toNumber() ?? 0;
    const occasionalIncomeExemptionUsed =
      summary?.occasionalIncomeExemptionUsedTRY.toNumber() ?? 0;

    return {
      taxYear,
      isDraft: summary?.isDraft ?? true,
      totalRealizedGainTRY: summary?.totalRealizedGainTRY.toNumber() ?? 0,
      totalRealizedLossTRY: summary?.totalRealizedLossTRY.toNumber() ?? 0,
      netCapitalGainTRY: summary?.netCapitalGainTRY.toNumber() ?? 0,
      occasionalIncomeTRY: summary?.occasionalIncomeTRY.toNumber() ?? 0,
      estimatedTaxableAmountTRY:
        summary?.estimatedTaxableAmountTRY.toNumber() ?? 0,
      capitalGainsExemption: {
        used: capitalGainsExemptionUsed,
        total: capitalGainsExemptionTotal,
        // Canli gösterge: istisnanin ne kadari kullanildi (0-100).
        usedPercent:
          capitalGainsExemptionTotal && capitalGainsExemptionTotal > 0
            ? Math.min(
                100,
                (capitalGainsExemptionUsed / capitalGainsExemptionTotal) * 100,
              )
            : 0,
      },
      occasionalIncomeExemption: {
        used: occasionalIncomeExemptionUsed,
        total: occasionalIncomeExemptionTotal,
        usedPercent:
          occasionalIncomeExemptionTotal && occasionalIncomeExemptionTotal > 0
            ? Math.min(
                100,
                (occasionalIncomeExemptionUsed /
                  occasionalIncomeExemptionTotal) *
                  100,
              )
            : 0,
      },
      calculatedAt: summary?.calculatedAt ?? null,
    };
  }

  /** Gerçekleşmemiş (hâlâ elde tutulan) pozisyonlar — coin bazlı, güncel fiyatla. */
  async getPositions(
    userId: string,
    filters: { asset?: string; exchangeConnectionId?: string } = {},
  ): Promise<PositionView[]> {
    const lots = await this.prisma.taxLot.findMany({
      where: {
        userId,
        remainingQuantity: { gt: 0 },
        ...(filters.asset ? { asset: filters.asset.toUpperCase() } : {}),
        ...(filters.exchangeConnectionId
          ? {
              acquisitionTransaction: {
                exchangeConnectionId: filters.exchangeConnectionId,
              },
            }
          : {}),
      },
    });

    const byAsset = new Map<
      string,
      { quantity: number; costBasisTRY: number }
    >();
    for (const lot of lots) {
      const qty = lot.remainingQuantity.toNumber();
      const cost = qty * lot.costBasisPerUnitTRY.toNumber();
      const existing = byAsset.get(lot.asset) ?? {
        quantity: 0,
        costBasisTRY: 0,
      };
      existing.quantity += qty;
      existing.costBasisTRY += cost;
      byAsset.set(lot.asset, existing);
    }

    const today = new Date();
    const results: PositionView[] = [];
    for (const [asset, agg] of byAsset) {
      const currentPrice = await this.priceData.getPrice(asset, 'TRY', today);
      const currentValueTRY =
        currentPrice != null ? currentPrice * agg.quantity : null;
      results.push({
        asset,
        quantity: agg.quantity,
        costBasisTRY: agg.costBasisTRY,
        currentValueTRY,
        unrealizedPnlTRY:
          currentValueTRY != null ? currentValueTRY - agg.costBasisTRY : null,
      });
    }
    return results.sort(
      (a, b) => (b.currentValueTRY ?? 0) - (a.currentValueTRY ?? 0),
    );
  }

  /** Borsa bazlı filtreleme icin — hangi ExchangeConnection/CSV/Wallet kaynaklari var. */
  async listSources(userId: string) {
    const [connections, wallets, csvImports] = await Promise.all([
      this.prisma.exchangeConnection.findMany({
        where: { userId },
        select: { id: true, provider: true, label: true },
      }),
      this.prisma.walletAddress.findMany({
        where: { userId },
        select: { id: true, chain: true, label: true },
      }),
      this.prisma.csvImport.findMany({
        where: { userId },
        select: { id: true, exchangeName: true },
      }),
    ]);
    return { connections, wallets, csvImports };
  }
}
