import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventType } from '../../generated/prisma/client';

export interface SecurityLogEntry {
  userId?: string;
  email?: string;
  eventType: SecurityEventType;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

// Basarisiz giris denemeleri, hesap kilitlenmesi, supheli aktivite —
// audit log'dan (normal is akisi) bilincli olarak ayri tutuluyor ki
// güvenlik incelemesi sirasinda gürültüye bogulmasin.
@Injectable()
export class SecurityLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(entry: SecurityLogEntry): Promise<void> {
    await this.prisma.securityLog.create({
      data: {
        userId: entry.userId,
        email: entry.email,
        eventType: entry.eventType,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        metadata: entry.metadata as never,
      },
    });
  }
}
