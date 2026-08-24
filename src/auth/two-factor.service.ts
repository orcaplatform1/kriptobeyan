import { Injectable } from '@nestjs/common';
import { generateSecret, generateURI, verify } from 'otplib';
import * as QRCode from 'qrcode';

const ISSUER = 'KriptoBeyan';

@Injectable()
export class TwoFactorService {
  generateSecret(): string {
    return generateSecret();
  }

  generateQrCodeDataUrl(email: string, secret: string): Promise<string> {
    const otpauthUrl = generateURI({ secret, label: email, issuer: ISSUER });
    return QRCode.toDataURL(otpauthUrl);
  }

  async verify(code: string, secret: string): Promise<boolean> {
    try {
      const result = await verify({ secret, token: code });
      return result.valid;
    } catch {
      return false;
    }
  }
}
