import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { RequestMeta } from '../auth/auth.service';

const DOCS_DIR = path.join(process.cwd(), 'storage', 'accountant-verification');
const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];

export type DocKind = 'license' | 'taxPlate';

// Sifre hash'i / 2FA secret'i gibi hassas alanlar admin onay ekranina bile
// ASLA donulmemeli — approve/reject sonucu dogrudan HTTP yanitina gidiyor.
const SAFE_SELECT = {
  id: true,
  email: true,
  username: true,
  fullName: true,
  accountantVerified: true,
  accountantVerifiedAt: true,
} as const;

@Injectable()
export class AccountantVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private saveFile(userId: string, kind: DocKind, file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Dosya bulunamadı');
    if (file.size > MAX_DOC_BYTES) {
      throw new BadRequestException('Dosya çok büyük (maks 8MB)');
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      throw new BadRequestException(
        'Sadece PNG, JPG, WEBP veya PDF yükleyebilirsin',
      );
    }
    const userDir = path.join(DOCS_DIR, userId);
    fs.mkdirSync(userDir, { recursive: true });
    const fileName = `${kind}-${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(userDir, fileName), file.buffer);
    return `${userId}/${fileName}`;
  }

  async uploadDocuments(
    userId: string,
    files: { license?: Express.Multer.File[]; taxPlate?: Express.Multer.File[] },
    meta: RequestMeta,
  ) {
    const data: Record<string, unknown> = {};
    if (files.license?.[0]) {
      data.accountantLicenseDocUrl = this.saveFile(userId, 'license', files.license[0]);
    }
    if (files.taxPlate?.[0]) {
      data.accountantTaxPlateDocUrl = this.saveFile(userId, 'taxPlate', files.taxPlate[0]);
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'En az bir belge (müşavirlik belgesi veya vergi levhası) yüklemelisin',
      );
    }
    // Yeni belge yuklenince onay sifirlanir — eskisi onaylanmis olsa bile
    // yeni belge tekrar admin incelemesi bekler.
    data.accountantVerified = false;
    data.accountantVerifiedAt = null;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        accountantLicenseDocUrl: true,
        accountantTaxPlateDocUrl: true,
        accountantVerified: true,
      },
    });

    await this.auditLog.log({
      userId,
      action: 'ACCOUNTANT_VERIFICATION_DOCS_UPLOADED',
      entity: 'User',
      entityId: userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  async getStatus(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        accountantLicenseDocUrl: true,
        accountantTaxPlateDocUrl: true,
        accountantVerified: true,
        accountantVerifiedAt: true,
      },
    });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');
    return {
      hasLicenseDoc: !!user.accountantLicenseDocUrl,
      hasTaxPlateDoc: !!user.accountantTaxPlateDocUrl,
      verified: user.accountantVerified,
      verifiedAt: user.accountantVerifiedAt,
    };
  }

  async getDocumentFile(requesterId: string, targetUserId: string, kind: DocKind) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { accountantLicenseDocUrl: true, accountantTaxPlateDocUrl: true },
    });
    const key = kind === 'license' ? user?.accountantLicenseDocUrl : user?.accountantTaxPlateDocUrl;
    if (!user || !key) throw new NotFoundException('Belge bulunamadı');

    if (targetUserId !== requesterId) {
      const staff = await this.prisma.staff.findUnique({ where: { userId: requesterId } });
      if (!staff) throw new NotFoundException('Belge bulunamadı');
    }

    const filePath = path.join(DOCS_DIR, key);
    if (!filePath.startsWith(DOCS_DIR) || !fs.existsSync(filePath)) {
      throw new NotFoundException('Belge bulunamadı');
    }
    return filePath;
  }

  /** Admin onay ekrani icin — iki belgeden en az biri yuklenmis, henuz
   *  onaylanmamis musavirler. */
  listPending() {
    return this.prisma.user.findMany({
      where: {
        role: 'ACCOUNTANT',
        accountantVerified: false,
        OR: [
          { accountantLicenseDocUrl: { not: null } },
          { accountantTaxPlateDocUrl: { not: null } },
        ],
      },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        accountantLicenseDocUrl: true,
        accountantTaxPlateDocUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approve(adminUserId: string, targetUserId: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { accountantVerified: true, accountantVerifiedAt: new Date() },
      select: SAFE_SELECT,
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ACCOUNTANT_VERIFICATION_APPROVED',
      entity: 'User',
      entityId: targetUserId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }

  async reject(adminUserId: string, targetUserId: string, meta: RequestMeta) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Kullanıcı bulunamadı');

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: {
        accountantVerified: false,
        accountantLicenseDocUrl: null,
        accountantTaxPlateDocUrl: null,
      },
      select: SAFE_SELECT,
    });

    await this.auditLog.log({
      userId: adminUserId,
      action: 'ACCOUNTANT_VERIFICATION_REJECTED',
      entity: 'User',
      entityId: targetUserId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return updated;
  }
}
