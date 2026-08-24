import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SecurityLogService } from '../security-log/security-log.service';
import { TwoFactorService } from './two-factor.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const REFRESH_TOKEN_BYTES = 48;

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
    private readonly securityLog: SecurityLogService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  async register(dto: RegisterDto, meta: RequestMeta) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Bu e-posta ile zaten bir hesap var');
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash },
    });

    await this.auditLog.log({
      userId: user.id,
      action: 'USER_REGISTERED',
      entity: 'User',
      entityId: user.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { id: user.id, email: user.email };
  }

  async login(dto: LoginDto, meta: RequestMeta): Promise<TokenPair | { twoFactorRequired: true }> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });

    if (!user) {
      await this.securityLog.log({
        email: dto.email,
        eventType: 'LOGIN_FAILED',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { reason: 'user_not_found' },
      });
      throw new UnauthorizedException('E-posta veya parola hatalı');
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.securityLog.log({
        userId: user.id,
        eventType: 'ACCOUNT_LOCKED',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { lockedUntil: user.lockedUntil },
      });
      throw new UnauthorizedException(
        `Hesap çok sayıda başarısız denemeden dolayı geçici kilitli, ${user.lockedUntil.toISOString()} sonrasında tekrar dene`,
      );
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      await this.registerFailedLogin(user.id, meta);
      throw new UnauthorizedException('E-posta veya parola hatalı');
    }

    if (user.failedLoginCount > 0) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
    }

    if (user.twoFactorEnabled) {
      if (!dto.totpCode) {
        return { twoFactorRequired: true };
      }
      if (!user.twoFactorSecretEncrypted) {
        throw new BadRequestException('2FA yapılandırması bozuk, destek ile iletişime geçin');
      }
      const secret = this.crypto.decrypt(user.twoFactorSecretEncrypted);
      const codeValid = await this.twoFactor.verify(dto.totpCode, secret);
      if (!codeValid) {
        await this.securityLog.log({
          userId: user.id,
          eventType: 'TWO_FA_FAILED',
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        throw new UnauthorizedException('2FA kodu hatalı');
      }
      await this.securityLog.log({
        userId: user.id,
        eventType: 'TWO_FA_SUCCESS',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
    }

    await this.securityLog.log({
      userId: user.id,
      eventType: 'LOGIN_SUCCESS',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    await this.auditLog.log({
      userId: user.id,
      action: 'LOGIN',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return this.issueTokenPair(user.id, user.email, meta);
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    // Bulunamadi VEYA daha once revoke edilmis bir token tekrar sunuldu —
    // ikinci durum caldirilan bir refresh token'in tekrar kullanilmaya
    // calisilmasi olabilir, guvenlik olayi olarak isaretleniyor.
    if (!stored) {
      throw new UnauthorizedException('Geçersiz refresh token');
    }
    if (stored.revokedAt) {
      await this.securityLog.log({
        userId: stored.userId,
        eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      // Ihlal suphesi: kullanicinin TUM aktif refresh token'larini iptal et.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Geçersiz refresh token, tüm oturumlar sonlandırıldı');
    }
    if (stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token süresi dolmuş');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(stored.userId, stored.user.email, meta);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async generateTwoFactorSecret(userId: string, email: string) {
    const secret = this.twoFactor.generateSecret();
    const encrypted = this.crypto.encrypt(secret);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecretEncrypted: encrypted },
    });
    const qrCodeDataUrl = await this.twoFactor.generateQrCodeDataUrl(email, secret);
    return { qrCodeDataUrl, secret };
  }

  async enableTwoFactor(userId: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.twoFactorSecretEncrypted) {
      throw new BadRequestException('Önce /auth/2fa/generate ile bir secret oluştur');
    }
    const secret = this.crypto.decrypt(user.twoFactorSecretEncrypted);
    if (!(await this.twoFactor.verify(code, secret))) {
      throw new UnauthorizedException('2FA kodu hatalı');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
    await this.auditLog.log({
      userId,
      action: '2FA_ENABLED',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  async disableTwoFactor(userId: string, password: string, code: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const passwordValid = await argon2.verify(user.passwordHash, password);
    if (!passwordValid || !user.twoFactorSecretEncrypted) {
      throw new UnauthorizedException('Parola veya 2FA kodu hatalı');
    }
    const secret = this.crypto.decrypt(user.twoFactorSecretEncrypted);
    if (!(await this.twoFactor.verify(code, secret))) {
      throw new UnauthorizedException('Parola veya 2FA kodu hatalı');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecretEncrypted: null },
    });
    await this.auditLog.log({
      userId,
      action: '2FA_DISABLED',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  private async registerFailedLogin(userId: string, meta: RequestMeta) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
    });

    await this.securityLog.log({
      userId,
      eventType: 'LOGIN_FAILED',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { failedLoginCount: user.failedLoginCount },
    });

    if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000);
      await this.prisma.user.update({ where: { id: userId }, data: { lockedUntil } });
      await this.securityLog.log({
        userId,
        eventType: 'ACCOUNT_LOCKED',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { lockedUntil },
      });
      this.logger.warn(`Kullanici ${userId} ${MAX_FAILED_LOGINS} basarisiz denemeden sonra kilitlendi`);
    }
  }

  private async issueTokenPair(userId: string, email: string, meta: RequestMeta): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync({ sub: userId, email });

    const rawRefreshToken = randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + this.parseDurationMs(process.env.JWT_REFRESH_EXPIRES_IN ?? '30d'));

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
    return value * unitMs;
  }
}
