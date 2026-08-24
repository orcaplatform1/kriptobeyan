import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM icin onerilen 96 bit

/**
 * Borsa API key'leri ve 2FA secret'ları gibi cok hassas alanlari at-rest
 * sifreler. ENCRYPTION_KEY BILINCLI olarak uygulamanin .env dosyasinda
 * DEGIL — /etc/kriptobeyan/secrets.env (root-only, git deposu disinda)
 * dosyasindan PM2 ecosystem.config.js tarafindan process ortamina enjekte
 * ediliyor. Burada dogrudan process.env okunuyor, ConfigService/.env
 * uzerinden DEGIL — bu ayrimin kod seviyesinde de acik olmasi icin.
 */
@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);
  private key!: Buffer;

  onModuleInit() {
    const hexKey = process.env.ENCRYPTION_KEY;
    if (!hexKey || hexKey.length !== 64) {
      throw new Error(
        'ENCRYPTION_KEY eksik veya gecersiz (64 hex karakter/32 byte bekleniyor). ' +
          '/etc/kriptobeyan/secrets.env dosyasini ve PM2 ecosystem env enjeksiyonunu kontrol et.',
      );
    }
    this.key = Buffer.from(hexKey, 'hex');
    this.logger.log(
      'Encryption key yuklendi (process env, .env dosyasindan degil)',
    );
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, authTagB64, cipherB64] = payload.split('.');
    if (!ivB64 || !authTagB64 || !cipherB64) {
      throw new Error('Gecersiz sifreli veri formati');
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(cipherB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}
