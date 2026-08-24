import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from './subscription.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CouponsService } from '../coupons/coupons.service';
import {
  CryptoAsset,
  CryptoProvider,
  PaymentMethod,
} from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';

/**
 * NOT: Gerçek bir ödeme gateway'i (kart için "sanal POS" — ör. iyzico — ya
 * da kripto için Binance Pay/Bybit Pay/OKX) henüz BAĞLANMADI (API
 * anahtarları lansmana kadar bilerek boş — bkz. env). Bu servis ödeme
 * kaydını PENDING olarak oluşturur; onay şu an admin'in manuel
 * `markCompleted`/`reject` çağırmasıyla yapılıyor (ORCA'nın kart/banka/
 * kripto ödemelerinde kullandığı "dekont/işlem kanıtı inceleme" akışının
 * birebir aynısı — bkz. traders.tr/core backend PaymentsService). Gerçek
 * gateway/webhook entegre edildiğinde markCompleted, webhook handler'dan
 * çağrılacak şekilde değiştirilmeli — iş mantığı (abonelik aktivasyonu)
 * zaten burada hazır.
 */

const RECEIPTS_DIR = path.join(process.cwd(), 'storage', 'receipts');
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024; // 8MB

// ORCA'daki ayni CoinGecko id eslemesi (bkz. traders.tr/core backend
// PaymentsService.COINGECKO_IDS) — kilitlenen tutari hesaplamak icin.
const COINGECKO_IDS: Record<CryptoAsset, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
};

export interface CreatePaymentOptions {
  cryptoProvider?: CryptoProvider;
  cryptoAsset?: CryptoAsset;
  receiptUrl?: string;
  couponCode?: string;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly auditLog: AuditLogService,
    private readonly coupons: CouponsService,
  ) {}

  private async fetchCryptoRateTRY(asset: CryptoAsset): Promise<number> {
    const coinId = COINGECKO_IDS[asset];
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=try`,
      );
      if (!res.ok) throw new Error('rate fetch failed');
      const data = await res.json();
      const rate = data?.[coinId]?.try;
      if (!rate) throw new Error('rate missing');
      return rate;
    } catch {
      throw new BadRequestException(
        'Kripto kuru şu anda alınamadı, lütfen tekrar dene.',
      );
    }
  }

  /** Saglayicinin cuzdan adresi env'den okunur — bkz. .env.example. Anahtar
   *  yoksa null doner, kullanici yine de PENDING odeme olusturabilir ve
   *  destek ekibiyle iletisime gecerek talimat alir (ORCA'nin OKX cuzdan
   *  fallback'iyla ayni mantik). */
  private getCryptoWalletAddress(provider: CryptoProvider): string | null {
    const key = `${provider}_WALLET_ADDRESS`;
    return process.env[key] ?? null;
  }

  async createPayment(
    userId: string,
    planId: string,
    method: PaymentMethod,
    meta: RequestMeta,
    options: CreatePaymentOptions = {},
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive)
      throw new NotFoundException('Plan bulunamadı veya aktif değil');
    if (plan.priceTRY.toNumber() === 0) {
      throw new BadRequestException('Ücretsiz plan için ödeme gerekmez');
    }

    if (method === 'CRYPTO' && !options.cryptoProvider) {
      throw new BadRequestException(
        'Kripto ile ödemede sağlayıcı seçimi zorunlu (Binance Pay, Bybit Pay veya OKX)',
      );
    }
    if (method === 'CRYPTO' && !options.cryptoAsset) {
      throw new BadRequestException(
        'Kripto ile ödemede varlık seçimi zorunlu (BTC, ETH veya USDT)',
      );
    }

    // Kullanicinin ayni turde (bireysel/musavir) suresi dolmamis aktif bir
    // abonelik plani varsa ve secilen plan ondan PAHALIYSA, bu bir "yukseltme"
    // olarak degerlendirilir — sadece fiyat farki alinir, plan.priceTRY DEGIL
    // (bkz. SubscriptionService.upgradeSubscription — bitis tarihi degismez,
    // ilk alinan paketin tarihi gecerli kalir). Bu tespit bilerek istemciden
    // gelen bir bayrakla degil, sunucu tarafinda otomatik yapiliyor ki
    // istemci "yukseltme" diyerek tam fiyati atlayamasin.
    const activeSub = await this.subscriptions.getActiveSubscription(userId);
    let isUpgrade = false;
    let previousPlanId: string | undefined;
    let amount = plan.priceTRY.toNumber();

    if (activeSub && activeSub.planId !== planId) {
      if (activeSub.plan.type !== plan.type) {
        throw new BadRequestException(
          'Bireysel ve mali müşavir planları arasında yükseltme yapılamaz, önce mevcut planın bitmesini bekle',
        );
      }
      const diff = amount - activeSub.plan.priceTRY.toNumber();
      if (diff <= 0) {
        throw new BadRequestException(
          'Bu plan mevcut planından daha ucuz veya ona eşit — yükseltme için daha üst bir plan seç',
        );
      }
      isUpgrade = true;
      previousPlanId = activeSub.planId;
      amount = diff;
    }

    // Musavir ortaklik kuponu — bkz. CouponsService. Yukseltme farkina da
    // uygulanabilir (musteri zaten kupon sahibiyle iliskiliyse).
    let couponId: string | undefined;
    let couponDiscountTRY: number | undefined;
    if (options.couponCode) {
      const coupon = await this.coupons.validateForRedeem(options.couponCode, userId);
      couponId = coupon.id;
      couponDiscountTRY = Math.round(amount * (coupon.discountPercent / 100) * 100) / 100;
      amount = Math.round((amount - couponDiscountTRY) * 100) / 100;
    }

    let cryptoAmountLocked: number | undefined;
    let cryptoRateTRY: number | undefined;

    if (method === 'CRYPTO' && options.cryptoAsset) {
      cryptoRateTRY = await this.fetchCryptoRateTRY(options.cryptoAsset);
      cryptoAmountLocked = Math.round((amount / cryptoRateTRY) * 1e8) / 1e8;
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId,
        amount,
        currency: 'TRY',
        method,
        cryptoProvider: options.cryptoProvider,
        cryptoAsset: options.cryptoAsset,
        cryptoAmountLocked,
        cryptoRateTRY,
        receiptUrl: options.receiptUrl,
        status: 'PENDING',
        isUpgrade,
        previousPlanId,
      },
    });

    if (couponId && couponDiscountTRY !== undefined) {
      await this.coupons.recordRedemption(couponId, userId, payment.id, couponDiscountTRY);
    }

    await this.auditLog.log({
      userId,
      action: isUpgrade ? 'PAYMENT_UPGRADE_CREATED' : 'PAYMENT_CREATED',
      entity: 'Payment',
      entityId: payment.id,
      metadata: {
        planName: plan.name,
        amount: amount.toString(),
        method,
        cryptoProvider: options.cryptoProvider,
        cryptoAsset: options.cryptoAsset,
        isUpgrade,
        previousPlanId,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const walletAddress =
      method === 'CRYPTO' && options.cryptoProvider
        ? this.getCryptoWalletAddress(options.cryptoProvider)
        : null;

    return { ...payment, cryptoWalletAddress: walletAddress };
  }

  listForUser(userId: string) {
    return this.prisma.payment.findMany({
      where: { userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Admin onay ekrani icin — bkz. AdminPaymentsController. */
  async listForAdmin(status?: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const where = status ? { status: status as any } : {};

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          plan: true,
          user: { select: { id: true, email: true, role: true } },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Admin panelinde gunluk/aylik/yillik ciro toggle'i icin — yukseltme
   *  odemeleri (isUpgrade) ayri bir alt-toplam olarak da donuluyor ki
   *  istatistikte "X TL ciro, bunun Y TL'si yukseltme" notu gosterilebilsin. */
  async getSalesStats() {
    const [daily, monthly, yearly] = await Promise.all([
      this.prisma.$queryRaw<
        { period: Date; count: number; revenue: number; upgradeCount: number; upgradeRevenue: number }[]
      >`
        SELECT DATE_TRUNC('day', "createdAt")::date AS period,
          COUNT(*)::int AS count, SUM(amount)::float AS revenue,
          COUNT(*) FILTER (WHERE "isUpgrade")::int AS "upgradeCount",
          COALESCE(SUM(amount) FILTER (WHERE "isUpgrade"), 0)::float AS "upgradeRevenue"
        FROM payments
        WHERE status = 'COMPLETED' AND "createdAt" >= NOW() - INTERVAL '30 days'
        GROUP BY period ORDER BY period ASC
      `,
      this.prisma.$queryRaw<
        { period: Date; count: number; revenue: number; upgradeCount: number; upgradeRevenue: number }[]
      >`
        SELECT DATE_TRUNC('month', "createdAt")::date AS period,
          COUNT(*)::int AS count, SUM(amount)::float AS revenue,
          COUNT(*) FILTER (WHERE "isUpgrade")::int AS "upgradeCount",
          COALESCE(SUM(amount) FILTER (WHERE "isUpgrade"), 0)::float AS "upgradeRevenue"
        FROM payments
        WHERE status = 'COMPLETED' AND "createdAt" >= NOW() - INTERVAL '12 months'
        GROUP BY period ORDER BY period ASC
      `,
      this.prisma.$queryRaw<
        { period: Date; count: number; revenue: number; upgradeCount: number; upgradeRevenue: number }[]
      >`
        SELECT DATE_TRUNC('year', "createdAt")::date AS period,
          COUNT(*)::int AS count, SUM(amount)::float AS revenue,
          COUNT(*) FILTER (WHERE "isUpgrade")::int AS "upgradeCount",
          COALESCE(SUM(amount) FILTER (WHERE "isUpgrade"), 0)::float AS "upgradeRevenue"
        FROM payments
        WHERE status = 'COMPLETED' AND "createdAt" >= NOW() - INTERVAL '5 years'
        GROUP BY period ORDER BY period ASC
      `,
    ]);
    return { daily, monthly, yearly };
  }

  /** Dekont/islem kaniti yukleme — sonucundaki `key` createPayment'a
   *  receiptUrl olarak gecilir (ORCA'daki uploadReceipt + receiptUrl akisiyla
   *  ayni iki adimli desen). */
  async uploadReceipt(userId: string, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Dosya bulunamadı');
    if (file.size > MAX_RECEIPT_BYTES) {
      throw new BadRequestException('Dosya çok büyük (maks 8MB)');
    }
    const allowedExt = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExt.includes(ext)) {
      throw new BadRequestException(
        'Sadece PNG, JPG, WEBP veya PDF yükleyebilirsin',
      );
    }

    const userDir = path.join(RECEIPTS_DIR, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const fileName = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(userDir, fileName), file.buffer);

    return { key: `${userId}/${fileName}` };
  }

  /** Sahibi ya da admin (staff tablosu) dekontu goruntuleyebilir. */
  async getReceiptFile(requesterId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || !payment.receiptUrl) {
      throw new NotFoundException('Dekont bulunamadı');
    }
    if (payment.userId !== requesterId) {
      const staff = await this.prisma.staff.findUnique({
        where: { userId: requesterId },
      });
      if (!staff) throw new NotFoundException('Dekont bulunamadı');
    }

    const filePath = path.join(RECEIPTS_DIR, payment.receiptUrl);
    if (!filePath.startsWith(RECEIPTS_DIR) || !fs.existsSync(filePath)) {
      throw new NotFoundException('Dekont bulunamadı');
    }
    return filePath;
  }

  /** Odeme olusturulduktan SONRA dekont/islem kaniti eklemek icin — kripto
   *  akisinda kullanici once odeme talebini olusturup kilitli tutari/adresi
   *  gorur, parayi gonderdikten sonra kanitini buradan yukler. */
  async attachReceipt(userId: string, paymentId: string, receiptUrl: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment || payment.userId !== userId) {
      throw new NotFoundException('Ödeme bulunamadı');
    }
    if (payment.status !== 'PENDING') {
      throw new BadRequestException('Sadece bekleyen ödemelere kanıt eklenebilir');
    }
    return this.prisma.payment.update({
      where: { id: paymentId },
      data: { receiptUrl },
    });
  }

  /** Admin/manuel onay — gercek gateway baglanana kadar. */
  async markCompleted(
    paymentId: string,
    adminUserId: string,
    meta: RequestMeta,
  ) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Ödeme bulunamadı');
    if (payment.status !== 'PENDING') {
      throw new BadRequestException('Sadece bekleyen ödemeler onaylanabilir');
    }

    // Yukseltme odemesi: SADECE plani degistirir, bitis tarihine dokunmaz
    // (bkz. SubscriptionService.upgradeSubscription). Normal odeme: yeni/
    // yenilenen 1 yillik donem baslatir.
    const subscription = payment.isUpgrade
      ? await this.subscriptions.upgradeSubscription(
          payment.userId,
          payment.planId,
        )
      : await this.subscriptions.activateSubscription(
          payment.userId,
          payment.planId,
        );
    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'COMPLETED', subscriptionId: subscription.id },
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'PAYMENT_APPROVED',
      entity: 'Payment',
      entityId: paymentId,
      metadata: { forUserId: payment.userId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  async reject(paymentId: string, adminUserId: string, meta: RequestMeta) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Ödeme bulunamadı');
    if (payment.status !== 'PENDING') {
      throw new BadRequestException('Sadece bekleyen ödemeler reddedilebilir');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'REJECTED' },
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'PAYMENT_REJECTED',
      entity: 'Payment',
      entityId: paymentId,
      metadata: { forUserId: payment.userId },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }
}
