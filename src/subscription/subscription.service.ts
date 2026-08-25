import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  UserRole,
  AccountantClientStatus,
} from '../../generated/prisma/client';

@Injectable()
export class SubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getActiveSubscription(userId: string) {
    return this.prisma.subscription.findFirst({
      where: { userId, status: 'ACTIVE', endDate: { gt: new Date() } },
      include: { plan: true },
      orderBy: { endDate: 'desc' },
    });
  }

  /**
   * "Ücretsiz" plan (priceTRY=0) kaydinin transactionLimit'i - hicbir aktif
   * aboneligi olmayan kullanicilarin HESAPLAMA (goruntuleme) icin serbest
   * sinirini belirler (Koinly modeli: import sinirsiz, hesaplama N iesleme
   * kadar ucretsiz). Admin panelden ("Ücretsiz" plani duzenleyerek) kod
   * degisikligi gerekmeden ayarlanabilir.
   */
  private async getFreeCalculationLimit(): Promise<number> {
    const freePlan = await this.prisma.plan.findFirst({
      where: { type: UserRole.INDIVIDUAL, priceTRY: 0, isActive: true },
    });
    return freePlan?.transactionLimit ?? 0;
  }

  /**
   * Bir vergi yili icin kullanicinin islem sayisi HESAPLAMA (tax-calculation)
   * icin izinli sinirin altinda mi. Aktif (odenmis) abonelik varsa o planin
   * transactionLimit'i gecerli; yoksa "Ücretsiz" planin serbest goruntuleme
   * siniri (bkz. getFreeCalculationLimit) kullanilir.
   */
  async checkTransactionLimit(
    userId: string,
    taxYear: number,
  ): Promise<{ allowed: boolean; used: number; limit: number | null; hasActivePlan: boolean }> {
    const sub = await this.getActiveSubscription(userId);
    const limit = sub ? sub.plan.transactionLimit : await this.getFreeCalculationLimit();
    const used = await this.prisma.transaction.count({
      where: { userId, taxYear },
    });
    if (limit === null) return { allowed: true, used, limit: null, hasActivePlan: !!sub }; // sinirsiz (TRADER)
    return { allowed: used <= limit, used, limit, hasActivePlan: !!sub };
  }

  /**
   * Rapor (PDF/Excel) URETIMI/indirme her zaman AKTIF (odenmis) bir abonelik
   * gerektirir - "Ücretsiz" planin hesaplama-goruntuleme serbestligi rapor
   * icin GECERLI DEGIL (CoinTracker modeli: import serbest ama rapor
   * kilitli). Aktif abonelik varsa da o planin transactionLimit'ini asan
   * yillar icin yine engellenir - kullanici islem sayisina uygun plana
   * yukseltmeli.
   */
  async checkReportAccess(
    userId: string,
    taxYear: number,
  ): Promise<{ allowed: boolean; used: number; limit: number | null; hasActivePlan: boolean }> {
    const sub = await this.getActiveSubscription(userId);
    const used = await this.prisma.transaction.count({
      where: { userId, taxYear },
    });
    if (!sub) return { allowed: false, used, limit: 0, hasActivePlan: false };
    const limit = sub.plan.transactionLimit;
    if (limit === null) return { allowed: true, used, limit: null, hasActivePlan: true };
    return { allowed: used <= limit, used, limit, hasActivePlan: true };
  }

  /**
   * Verilen islem sayisina yetecek EN UCUZ ucretli plani onerir (limitine
   * uygun plana yonlendirme icin - kullanici istegi 2026-08-25: "nasilsa
   * indirmek icin kendine uygun plan alacak, kendine uygun plana
   * yonlendir"). Hicbir plan yetmiyorsa (islem sayisi en buyuk planin
   * sinirini da asiyorsa) en buyuk plan onerilir.
   */
  async recommendPlan(txCount: number, type: UserRole = UserRole.INDIVIDUAL) {
    const plans = await this.prisma.plan.findMany({
      where: { isActive: true, type, priceTRY: { gt: 0 } },
      orderBy: { priceTRY: 'asc' },
    });
    const fit = plans.find((p) => p.transactionLimit === null || p.transactionLimit >= txCount);
    return fit ?? plans[plans.length - 1] ?? null;
  }

  /** Muhasebeci icin aktif musteri slotu kullanimi. */
  async checkClientSlotAvailable(
    accountantUserId: string,
  ): Promise<{ allowed: boolean; used: number; limit: number | null }> {
    const sub = await this.getActiveSubscription(accountantUserId);
    const limit = sub?.plan.clientLimit ?? 0;
    if (limit === null) return { allowed: true, used: 0, limit: null };

    const used = await this.prisma.accountantClient.count({
      where: {
        accountantUserId,
        status: {
          in: [AccountantClientStatus.ACTIVE, AccountantClientStatus.PENDING],
        },
      },
    });
    return { allowed: used < limit, used, limit };
  }

  async getUsageSummary(userId: string, role: UserRole) {
    const sub = await this.getActiveSubscription(userId);
    const activePlan = sub
      ? {
          id: sub.plan.id,
          name: sub.plan.name,
          priceTRY: sub.plan.priceTRY.toString(),
          type: sub.plan.type,
        }
      : null;
    if (role === 'ACCOUNTANT') {
      const slot = await this.checkClientSlotAvailable(userId);
      return {
        planName: sub?.plan.name ?? null,
        endDate: sub?.endDate ?? null,
        activePlan,
        clients: slot,
      };
    }
    const tx = await this.checkTransactionLimit(userId, new Date().getUTCFullYear());
    return {
      planName: sub?.plan.name ?? null,
      endDate: sub?.endDate ?? null,
      activePlan,
      transactions: tx,
    };
  }

  /** Bir odeme COMPLETED oldugunda cagrilir — mevcut aboneligi 1 yil uzatir/yeniler. */
  async activateSubscription(userId: string, planId: string) {
    const now = new Date();
    const endDate = new Date(now);
    endDate.setFullYear(endDate.getFullYear() + 1);

    return this.prisma.subscription.create({
      data: { userId, planId, status: 'ACTIVE', startDate: now, endDate },
    });
  }

  /**
   * Aynı 1 yıllık dönem içinde daha üst bir plana geçiş — SADECE fiyat farkı
   * ödenir (bkz. PaymentService.createPayment isUpgrade hesaplaması).
   * startDate/endDate BİLEREK değiştirilmiyor: ilk satın alınan paketin
   * bitiş tarihi geçerli kalır, yükseltme süreyi uzatmaz/sıfırlamaz.
   */
  async upgradeSubscription(userId: string, planId: string) {
    const sub = await this.getActiveSubscription(userId);
    if (!sub) {
      // Aktif abonelik bitmis/hic olmamis olabilir — bu durumda normal
      // (yeni donem baslatan) aktivasyona dus.
      return this.activateSubscription(userId, planId);
    }
    return this.prisma.subscription.update({
      where: { id: sub.id },
      data: { planId },
    });
  }
}
