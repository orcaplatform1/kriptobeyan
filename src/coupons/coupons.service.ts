import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_DISCOUNT_PERCENT = 15;
const CODE_SUFFIX_DIGITS = 4;

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  private async generateUniqueCode(username: string): Promise<string> {
    const base = username.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'MUSAVIR';
    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = randomInt(0, 10 ** CODE_SUFFIX_DIGITS)
        .toString()
        .padStart(CODE_SUFFIX_DIGITS, '0');
      const code = `${base}${suffix}`;
      const exists = await this.prisma.couponCode.findUnique({ where: { code } });
      if (!exists) return code;
    }
    throw new BadRequestException('Kod üretilemedi, tekrar dene');
  }

  async getMyCoupon(accountantUserId: string) {
    const coupon = await this.prisma.couponCode.findFirst({
      where: { accountantUserId },
      include: { _count: { select: { redemptions: true } } },
    });
    if (!coupon) return null;

    const totalDiscount = await this.prisma.couponRedemption.aggregate({
      where: { couponCodeId: coupon.id },
      _sum: { discountTRY: true },
    });

    return {
      id: coupon.id,
      code: coupon.code,
      discountPercent: coupon.discountPercent,
      isActive: coupon.isActive,
      createdAt: coupon.createdAt,
      redemptionCount: coupon._count.redemptions,
      totalDiscountGivenTRY: totalDiscount._sum.discountTRY?.toString() ?? '0',
    };
  }

  async createMyCoupon(accountantUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: accountantUserId },
      select: { username: true, role: true, accountantVerified: true },
    });
    if (!user || user.role !== 'ACCOUNTANT') {
      throw new ForbiddenException('Sadece mali müşavir hesapları kupon oluşturabilir');
    }
    if (!user.accountantVerified) {
      throw new ForbiddenException(
        'Kupon oluşturabilmek için önce müşavirlik belgeni ve vergi levhanı yükleyip admin onayı almalısın',
      );
    }

    const existing = await this.prisma.couponCode.findFirst({
      where: { accountantUserId },
    });
    if (existing) {
      throw new BadRequestException('Zaten bir kuponun var');
    }

    const code = await this.generateUniqueCode(user.username);
    const coupon = await this.prisma.couponCode.create({
      data: {
        code,
        accountantUserId,
        discountPercent: DEFAULT_DISCOUNT_PERCENT,
      },
    });
    return this.getMyCoupon(accountantUserId) ?? coupon;
  }

  /** Odeme olusturulurken cagirilir — bkz. PaymentService.createPayment. */
  async validateForRedeem(code: string, payerUserId: string) {
    const coupon = await this.prisma.couponCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });
    if (!coupon || !coupon.isActive) {
      throw new BadRequestException('Kupon kodu geçersiz');
    }
    if (coupon.accountantUserId === payerUserId) {
      throw new BadRequestException('Kendi kuponunu kullanamazsın');
    }
    return coupon;
  }

  async recordRedemption(
    couponCodeId: string,
    userId: string,
    paymentId: string,
    discountTRY: number,
  ) {
    await this.prisma.couponRedemption.create({
      data: { couponCodeId, userId, paymentId, discountTRY },
    });
  }

  /** Admin: musavir basina getirdigi musteri/ciro ozeti — bkz.
   *  "is ortakligi programi" istegi, komisyon/performans takibi icin. */
  async listAllForAdmin() {
    const coupons = await this.prisma.couponCode.findMany({
      include: {
        accountant: { select: { id: true, email: true, username: true, fullName: true } },
        _count: { select: { redemptions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(
      coupons.map(async (c) => {
        const totalDiscount = await this.prisma.couponRedemption.aggregate({
          where: { couponCodeId: c.id },
          _sum: { discountTRY: true },
        });
        return {
          id: c.id,
          code: c.code,
          discountPercent: c.discountPercent,
          isActive: c.isActive,
          createdAt: c.createdAt,
          accountant: c.accountant,
          redemptionCount: c._count.redemptions,
          totalDiscountGivenTRY: totalDiscount._sum.discountTRY?.toString() ?? '0',
        };
      }),
    );
  }

  async setActive(couponId: string, isActive: boolean) {
    const coupon = await this.prisma.couponCode.findUnique({ where: { id: couponId } });
    if (!coupon) throw new NotFoundException('Kupon bulunamadı');
    return this.prisma.couponCode.update({ where: { id: couponId }, data: { isActive } });
  }
}
