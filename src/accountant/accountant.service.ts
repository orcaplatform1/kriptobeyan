import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AccountantClientStatus } from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';

const INVITE_TOKEN_BYTES = 32;
const INVITE_EXPIRES_DAYS = 14;
const APP_URL = process.env.APP_URL ?? 'https://kriptobeyan.com';

/**
 * KVKK/güvenlik gereği: bu servis hiçbir yerde ExchangeConnection veya
 * borsa API key'i sorgulamaz/döndürmez — sadece TaxYearSummary,
 * ReconciliationFlag gibi ÖNCEDEN HESAPLANMIŞ, hesap kimlik bilgisi
 * içermeyen verilere erişir. Her erişimde AccountantClient ilişkisi
 * (status=ACTIVE) üzerinden sıkı yetki kontrolü yapılır (bkz. assertAccess).
 */
@Injectable()
export class AccountantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly auditLog: AuditLogService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  async inviteClient(
    accountantUserId: string,
    email: string,
    meta: RequestMeta,
  ) {
    const accountant = await this.prisma.user.findUnique({
      where: { id: accountantUserId },
      select: { accountantVerified: true },
    });
    if (!accountant?.accountantVerified) {
      throw new ForbiddenException(
        'Müşteri davet edebilmek için önce müşavirlik belgeni ve vergi levhanı yükleyip admin onayı almalısın',
      );
    }

    const slot =
      await this.subscriptions.checkClientSlotAvailable(accountantUserId);
    if (!slot.allowed) {
      throw new BadRequestException(
        `Müşteri slotu doldu (${slot.used}/${slot.limit}) — yeni müşteri eklemek için plan yükseltin`,
      );
    }

    const existingClient = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingClient) {
      const alreadyLinked = await this.prisma.accountantClient.findFirst({
        where: {
          accountantUserId,
          clientUserId: existingClient.id,
          status: { not: 'REMOVED' },
        },
      });
      if (alreadyLinked)
        throw new BadRequestException('Bu kullanıcı zaten müşteri listenizde');
    }

    const token = randomBytes(INVITE_TOKEN_BYTES).toString('hex');
    const invite = await this.prisma.accountantClient.create({
      data: {
        accountantUserId,
        inviteEmail: email,
        inviteTokenHash: this.hashToken(token),
        inviteExpiresAt: new Date(
          Date.now() + INVITE_EXPIRES_DAYS * 86_400_000,
        ),
        status: AccountantClientStatus.PENDING,
      },
    });

    await this.mail.send({
      to: email,
      subject: 'KriptoBeyan — Mali müşavir daveti',
      html:
        `Mali müşaviriniz sizi KriptoBeyan'a davet etti. Hesabınız yoksa önce kayıt olun, ` +
        `ardından daveti kabul etmek için: <a href="${APP_URL}/muhasebeci-daveti?token=${token}">buraya tıklayın</a> ` +
        `(${INVITE_EXPIRES_DAYS} gün geçerli). Mali müşaviriniz borsa API key'lerinizi ASLA göremez — sadece ` +
        `hesapladığınız vergi özetine erişir.`,
    });

    await this.auditLog.log({
      userId: accountantUserId,
      action: 'ACCOUNTANT_CLIENT_INVITED',
      entity: 'AccountantClient',
      entityId: invite.id,
      metadata: { email },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { id: invite.id, email, status: invite.status };
  }

  async acceptInvite(clientUserId: string, token: string, meta: RequestMeta) {
    const tokenHash = this.hashToken(token);
    const invite = await this.prisma.accountantClient.findFirst({
      where: {
        inviteTokenHash: tokenHash,
        status: AccountantClientStatus.PENDING,
      },
    });
    if (
      !invite ||
      !invite.inviteExpiresAt ||
      invite.inviteExpiresAt < new Date()
    ) {
      throw new BadRequestException(
        'Davet bağlantısı geçersiz veya süresi dolmuş',
      );
    }

    const updated = await this.prisma.accountantClient.update({
      where: { id: invite.id },
      data: {
        clientUserId,
        status: AccountantClientStatus.ACTIVE,
        acceptedAt: new Date(),
        inviteTokenHash: null,
      },
    });

    await this.notifications.notifyAccountant(
      invite.accountantUserId,
      `Davet ettiğiniz müşteri (${invite.inviteEmail}) daveti kabul etti.`,
    );

    await this.auditLog.log({
      userId: clientUserId,
      action: 'ACCOUNTANT_INVITE_ACCEPTED',
      entity: 'AccountantClient',
      entityId: invite.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  async listClients(accountantUserId: string) {
    const clients = await this.prisma.accountantClient.findMany({
      where: {
        accountantUserId,
        status: { not: AccountantClientStatus.REMOVED },
      },
      include: {
        client: {
          select: {
            id: true,
            email: true,
            fullName: true,
            activeTaxYear: true,
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });
    return clients;
  }

  /** Tum musterilerin ozet durumu tek tabloda — bkz. "toplu gorunum" istegi. */
  async overview(accountantUserId: string) {
    const clients = await this.listClients(accountantUserId);
    const results = [];
    for (const c of clients) {
      if (c.status !== AccountantClientStatus.ACTIVE || !c.clientUserId) {
        results.push({
          ...c,
          hasCompletedReport: false,
          unresolvedFlagCount: 0,
        });
        continue;
      }
      const [summary, flagCount] = await Promise.all([
        this.prisma.taxYearSummary.findFirst({
          where: { userId: c.clientUserId, taxYear: c.client!.activeTaxYear },
        }),
        this.prisma.reconciliationFlag.count({
          where: { userId: c.clientUserId, resolved: false },
        }),
      ]);
      results.push({
        ...c,
        hasCompletedReport: !!summary,
        unresolvedFlagCount: flagCount,
      });
    }
    return results;
  }

  async getClientSummary(accountantUserId: string, clientUserId: string) {
    await this.assertAccess(accountantUserId, clientUserId);

    const [summaries, flags, client] = await Promise.all([
      this.prisma.taxYearSummary.findMany({
        where: { userId: clientUserId },
        orderBy: { taxYear: 'desc' },
      }),
      this.prisma.reconciliationFlag.findMany({
        where: { userId: clientUserId, resolved: false },
      }),
      this.prisma.user.findUnique({
        where: { id: clientUserId },
        select: {
          id: true,
          email: true,
          fullName: true,
          activeTaxYear: true,
          taxpayerType: true,
        },
      }),
    ]);
    return { client, summaries, unresolvedFlags: flags };
  }

  async removeClient(
    accountantUserId: string,
    accountantClientId: string,
    meta: RequestMeta,
  ) {
    const link = await this.prisma.accountantClient.findUnique({
      where: { id: accountantClientId },
    });
    if (!link || link.accountantUserId !== accountantUserId) {
      throw new NotFoundException('Müşteri ilişkisi bulunamadı');
    }
    const updated = await this.prisma.accountantClient.update({
      where: { id: accountantClientId },
      data: { status: AccountantClientStatus.REMOVED, removedAt: new Date() },
    });
    await this.auditLog.log({
      userId: accountantUserId,
      action: 'ACCOUNTANT_CLIENT_REMOVED',
      entity: 'AccountantClient',
      entityId: accountantClientId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return updated;
  }

  /**
   * KRİTİK yetki kontrolü — bir muhasebeci SADECE kendi AccountantClient
   * ilişkisindeki (status=ACTIVE) kullanıcıların verisine erişebilir.
   */
  private async assertAccess(
    accountantUserId: string,
    clientUserId: string,
  ): Promise<void> {
    const link = await this.prisma.accountantClient.findFirst({
      where: {
        accountantUserId,
        clientUserId,
        status: AccountantClientStatus.ACTIVE,
      },
    });
    if (!link) {
      throw new ForbiddenException(
        'Bu kullanıcının verisine erişim yetkiniz yok',
      );
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
