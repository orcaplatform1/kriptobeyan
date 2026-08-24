import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationType, UserRole } from '../../generated/prisma/client';

const DECLARATION_MONTH = 3; // Mart — beyan donemi (Turkiye)

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  listForUser(userId: string) {
    return this.prisma.notificationLog.findMany({
      where: { userId },
      orderBy: { sentAt: 'desc' },
      take: 100,
    });
  }

  async markRead(userId: string, notificationId: string) {
    await this.prisma.notificationLog.updateMany({
      where: { id: notificationId, userId },
      data: { readAt: new Date() },
    });
  }

  async flagDataIssue(userId: string, message: string) {
    await this.create(userId, NotificationType.DATA_ISSUE, message);
  }

  async notifyAccountant(accountantUserId: string, message: string) {
    await this.create(
      accountantUserId,
      NotificationType.ACCOUNTANT_CLIENT_ACTIVITY,
      message,
    );
  }

  private async create(
    userId: string,
    type: NotificationType,
    message: string,
  ) {
    await this.prisma.notificationLog.create({
      data: { userId, type, message },
    });
  }

  /** Admin panelinden tum kullanicilara ya da tek bir role duyuru — bkz.
   *  AdminAnnouncementsController. */
  async broadcast(message: string, role?: UserRole): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: role ? { role } : {},
      select: { id: true },
    });
    if (users.length === 0) return 0;

    await this.prisma.notificationLog.createMany({
      data: users.map((u) => ({
        userId: u.id,
        type: NotificationType.ANNOUNCEMENT,
        message,
      })),
    });
    return users.length;
  }

  // Gercek cron giris noktasi — sistem saatini kullanir. Test edilebilirlik
  // icin gercek is mantigi ayri bir metotta (bkz. runDeclarationReminders),
  // burasi sadece onu cagirir. Boylece testte sistem saatini degistirmeden
  // `service.runDeclarationReminders(new Date('2026-03-15'))` gibi belirli
  // bir tarihi simule edip cron'un DOGRU AYDA tetiklendigini dogrulayabiliriz.
  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendDeclarationReminders(): Promise<void> {
    await this.runDeclarationReminders(new Date());
  }

  /**
   * Sadece Mart ayinda ve o kullanici icin bu yil daha once hatirlatma
   * gonderilmemisse bildirim+mail yollar (bkz. declarationReminderEnabled
   * tercihi). Idempotent — ayni yil icin ikinci kez calismaz (NotificationLog'da
   * bu yila ait DECLARATION_REMINDER var mi kontrol edilir).
   */
  async runDeclarationReminders(now: Date): Promise<number> {
    if (now.getUTCMonth() + 1 !== DECLARATION_MONTH) return 0;

    const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const users = await this.prisma.user.findMany({
      where: { declarationReminderEnabled: true, emailVerified: true },
      select: { id: true, email: true },
    });

    let sent = 0;
    for (const user of users) {
      const alreadySent = await this.prisma.notificationLog.findFirst({
        where: {
          userId: user.id,
          type: NotificationType.DECLARATION_REMINDER,
          sentAt: { gte: yearStart },
        },
      });
      if (alreadySent) continue;

      const message =
        'Kripto varlık beyan dönemi yaklaşıyor — vergi özetinizi gözden geçirmeyi unutmayın.';
      await this.create(
        user.id,
        NotificationType.DECLARATION_REMINDER,
        message,
      );
      await this.mail.send({
        to: user.email,
        subject: 'KriptoBeyan — Beyan dönemi hatırlatması',
        html: message,
      });
      sent++;
    }
    if (sent > 0)
      this.logger.log(
        `${sent} kullanıcıya beyan dönemi hatırlatması gönderildi`,
      );
    return sent;
  }
}
