import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

export interface SmsMessage {
  to: string; // E.164, ör. +905XXXXXXXXX
  body: string;
}

// SMS_PROVIDER_API_KEY lansmana kadar bilinçli olarak bos birakilabilir
// (bkz. proje notu: API anahtarlari lansmana kadar bekletiliyor, ayni
// MailService'teki SMTP_HOST deseni) — bu durumda SMS gonderilmez, sadece
// loglanir. Kod admin panelden de elle dogrulanabilir (User.phoneVerified).
@Injectable()
export class SmsService implements OnModuleInit {
  private readonly logger = new Logger(SmsService.name);
  private apiKey: string | null = null;

  onModuleInit() {
    this.apiKey = process.env.SMS_PROVIDER_API_KEY ?? null;
    if (!this.apiKey) {
      this.logger.warn(
        'SMS_PROVIDER_API_KEY tanimli degil — SMS gonderilmeyecek, sadece loglanacak',
      );
    }
  }

  async send(message: SmsMessage): Promise<void> {
    if (!this.apiKey) {
      this.logger.log(
        `[SMS - sağlayıcı yapılandırılmadı] to=${message.to} body="${message.body}"`,
      );
      return;
    }
    // Gercek saglayici (ör. Netgsm/Twilio) entegrasyonu API_KEY eklendiginde
    // burada yazilacak — su an sadece loglanir ki kod yine ulasilabilir olsun.
    this.logger.log(`[SMS] to=${message.to} body="${message.body}"`);
  }
}
