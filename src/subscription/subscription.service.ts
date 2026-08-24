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
   * Bireysel kullanicilar icin bu yilki islem sayisi plan limitini asiyor mu.
   * Aktif abonelik yoksa FREE plan (transactionLimit=0) varsayilir — hicbir
   * rapor/limitli islem yapilamaz, sadece goruntuleme.
   */
  async checkTransactionLimit(
    userId: string,
  ): Promise<{ allowed: boolean; used: number; limit: number | null }> {
    const sub = await this.getActiveSubscription(userId);
    const limit = sub?.plan.transactionLimit ?? 0;
    if (limit === null) return { allowed: true, used: 0, limit: null }; // sinirsiz (TRADER)

    const currentYear = new Date().getUTCFullYear();
    const used = await this.prisma.transaction.count({
      where: { userId, taxYear: currentYear },
    });
    return { allowed: used < limit, used, limit };
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
    if (role === 'ACCOUNTANT') {
      const slot = await this.checkClientSlotAvailable(userId);
      return {
        planName: sub?.plan.name ?? null,
        endDate: sub?.endDate ?? null,
        clients: slot,
      };
    }
    const tx = await this.checkTransactionLimit(userId);
    return {
      planName: sub?.plan.name ?? null,
      endDate: sub?.endDate ?? null,
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
}
