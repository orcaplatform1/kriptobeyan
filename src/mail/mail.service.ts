import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
}

// SMTP_HOST/USER/PASS lansmana kadar bilinçli olarak bos birakilabilir
// (bkz. proje notu: API anahtarlari lansmana kadar bekletiliyor) — bu
// durumda mail gonderilmez, sadece loglanir (dev/test icin yeterli).
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  onModuleInit() {
    const host = process.env.SMTP_HOST;
    if (!host) {
      this.logger.warn(
        'SMTP_HOST tanimli degil — mailler gonderilmeyecek, sadece loglanacak',
      );
      return;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.transporter) {
      this.logger.log(
        `[MAIL - SMTP yapılandırılmadı] to=${message.to} subject="${message.subject}"`,
      );
      return;
    }
    await this.transporter.sendMail({
      from: process.env.SMTP_FROM ?? 'KriptoBeyan <no-reply@kriptobeyan.com>',
      ...message,
    });
  }
}
