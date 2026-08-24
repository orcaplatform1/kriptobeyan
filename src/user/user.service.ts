import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateTaxSettingsDto } from './dto/update-tax-settings.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import type { RequestMeta } from '../auth/auth.service';

// Sifre hash'i ve diger hassas alanlar (2FA secret, dogrulama/reset
// token hash'leri) HICBIR uc noktada disariya donulmez.
const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  fullName: true,
  phone: true,
  emailVerified: true,
  twoFactorEnabled: true,
  baseCurrency: true,
  costBasisMethod: true,
  taxpayerType: true,
  timezone: true,
  jurisdiction: true,
  activeTaxYear: true,
  declarationReminderEnabled: true,
  createdAt: true,
} as const;

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER_SELECT,
    });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');
    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: PUBLIC_USER_SELECT,
    });
  }

  async updateTaxSettings(
    userId: string,
    dto: UpdateTaxSettingsDto,
    meta: RequestMeta,
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: PUBLIC_USER_SELECT,
    });
    await this.auditLog.log({
      userId,
      action: 'TAX_SETTINGS_UPDATED',
      metadata: { ...dto },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return user;
  }

  async setActiveTaxYear(userId: string, taxYear: number) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { activeTaxYear: taxYear },
      select: PUBLIC_USER_SELECT,
    });
  }

  async updateNotificationPreferences(
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: PUBLIC_USER_SELECT,
    });
  }
}
