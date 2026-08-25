import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UserRole } from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';

// Admin listesinde/detayinda ASLA disari cikmayacak alanlar — sifre hash'i,
// 2FA secret'i, dogrulama/sifirlama token hash'leri.
const SAFE_USER_SELECT = {
  id: true,
  email: true,
  username: true,
  fullName: true,
  phone: true,
  phoneCountryCode: true,
  role: true,
  emailVerified: true,
  phoneVerified: true,
  createdAt: true,
  lastSeenAt: true,
  lockedUntil: true,
  failedLoginCount: true,
  twoFactorEnabled: true,
  staffRecord: { select: { id: true, role: true, addedAt: true } },
} as const;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(
    opts: {
      role?: UserRole;
      staffOnly?: boolean;
      search?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    const where = {
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.staffOnly ? { staffRecord: { isNot: null } } : {}),
      ...(opts.search
        ? {
            OR: [
              { email: { contains: opts.search, mode: 'insensitive' as const } },
              { username: { contains: opts.search, mode: 'insensitive' as const } },
              { fullName: { contains: opts.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: SAFE_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  async getOne(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...SAFE_USER_SELECT,
        _count: {
          select: {
            exchangeConnections: true,
            walletAddresses: true,
            csvImports: true,
            payments: true,
          },
        },
      },
    });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');

    const [subscription, reports, invite] = await Promise.all([
      this.prisma.subscription.findFirst({
        where: { userId, status: 'ACTIVE', endDate: { gt: new Date() } },
        include: { plan: true },
        orderBy: { endDate: 'desc' },
      }),
      this.prisma.generatedReport.findMany({
        where: { userId },
        select: { id: true, taxYear: true, format: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      // Bu kullanicinin bir mali musavir daveti uzerinden bagli olup
      // olmadigi — SADECE ADMIN gorur (kullanici istegi 2026-08-25: "bunu
      // yalnizca admin gorsun"). Musavir-tarafinda (accountant.service.ts)
      // ve kullanicinin kendi profilinde (user.controller.ts) bu bilgi
      // KESINLIKLE donmemeli.
      this.prisma.accountantClient.findFirst({
        where: { clientUserId: userId, status: 'ACTIVE' },
        select: { accountant: { select: { username: true } } },
      }),
    ]);

    return {
      ...user,
      activeSubscription: subscription,
      reports,
      invitedByAccountant: invite?.accountant ?? null,
    };
  }

  async update(
    adminUserId: string,
    userId: string,
    dto: AdminUpdateUserDto,
    meta: RequestMeta,
  ) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('Kullanıcı bulunamadı');

    if (dto.email && dto.email !== target.email) {
      const taken = await this.prisma.user.findUnique({ where: { email: dto.email } });
      if (taken) throw new ConflictException('Bu e-posta başka bir hesapta kayıtlı');
    }
    if (dto.username && dto.username !== target.username) {
      const taken = await this.prisma.user.findUnique({ where: { username: dto.username } });
      if (taken) throw new ConflictException('Bu kullanıcı adı başka bir hesapta kayıtlı');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        email: dto.email,
        username: dto.username,
        fullName: dto.fullName,
        phone: dto.phone,
        role: dto.role,
        emailVerified: dto.emailVerified,
        phoneVerified: dto.phoneVerified,
        ...(dto.unlock ? { lockedUntil: null, failedLoginCount: 0 } : {}),
      },
      select: SAFE_USER_SELECT,
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ADMIN_USER_UPDATED',
      entity: 'User',
      entityId: userId,
      metadata: { ...dto },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  private async assertNotLastStaff(userId: string) {
    const staffCount = await this.prisma.staff.count();
    const targetIsStaff = await this.prisma.staff.findUnique({ where: { userId } });
    if (targetIsStaff && staffCount <= 1) {
      throw new BadRequestException(
        'Son admin/staff hesabı — önce başka bir hesabı admin yap',
      );
    }
  }

  async grantStaff(adminUserId: string, userId: string, meta: RequestMeta) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('Kullanıcı bulunamadı');

    await this.prisma.staff.upsert({
      where: { userId },
      update: {},
      create: { userId, role: 'ADMIN', addedById: adminUserId },
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ADMIN_STAFF_GRANTED',
      entity: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return this.getOne(userId);
  }

  async revokeStaff(adminUserId: string, userId: string, meta: RequestMeta) {
    if (userId === adminUserId) {
      throw new ForbiddenException('Kendi admin yetkini kendin kaldıramazsın');
    }
    await this.assertNotLastStaff(userId);

    await this.prisma.staff.deleteMany({ where: { userId } });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ADMIN_STAFF_REVOKED',
      entity: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return this.getOne(userId);
  }

  async remove(adminUserId: string, userId: string, meta: RequestMeta) {
    if (userId === adminUserId) {
      throw new ForbiddenException('Kendi hesabını buradan silemezsin');
    }
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('Kullanıcı bulunamadı');

    await this.assertNotLastStaff(userId);

    // Iliskili her sey (borsa baglantilari, cuzdanlar, islemler, odemeler,
    // audit/security log kayitlari vb.) schema.prisma'da onDelete: Cascade
    // ile tanimli — ayrica tek tek silmeye gerek yok.
    await this.prisma.user.delete({ where: { id: userId } });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ADMIN_USER_DELETED',
      entity: 'User',
      entityId: userId,
      metadata: { email: target.email, username: target.username },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }
}
