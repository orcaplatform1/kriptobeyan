import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from './subscription.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PaymentMethod } from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';

/**
 * NOT: Gerçek bir ödeme gateway'i (kart için "sanal POS" — ör. iyzico — ya
 * da kripto için Binance Pay/Bybit Pay) henüz BAĞLANMADI. Bu servis
 * ödeme kaydını PENDING olarak oluşturur; onay şu an admin'in manuel
 * `markCompleted` çağırmasıyla yapılıyor (ORCA'nın kart/banka ödemelerinde
 * kullandığı "makbuz inceleme" akışına benzer). Gerçek gateway entegre
 * edildiğinde markCompleted, webhook handler'dan çağrılacak şekilde
 * değiştirilmeli — iş mantığı (abonelik aktivasyonu) zaten burada hazır.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly auditLog: AuditLogService,
  ) {}

  async createPayment(
    userId: string,
    planId: string,
    method: PaymentMethod,
    meta: RequestMeta,
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive)
      throw new NotFoundException('Plan bulunamadı veya aktif değil');
    if (plan.priceTRY.toNumber() === 0) {
      throw new BadRequestException('Ücretsiz plan için ödeme gerekmez');
    }

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        planId,
        amount: plan.priceTRY,
        currency: 'TRY',
        method,
        status: 'PENDING',
      },
    });

    await this.auditLog.log({
      userId,
      action: 'PAYMENT_CREATED',
      entity: 'Payment',
      entityId: payment.id,
      metadata: {
        planName: plan.name,
        amount: plan.priceTRY.toString(),
        method,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return payment;
  }

  listForUser(userId: string) {
    return this.prisma.payment.findMany({
      where: { userId },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
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

    const subscription = await this.subscriptions.activateSubscription(
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
}
