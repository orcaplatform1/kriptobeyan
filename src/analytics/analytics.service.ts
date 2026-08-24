import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const ACTIVE_WINDOW_MS = 5 * 60_000; // 5 dakika

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function mondayStr() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Pazar
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}

function monthPrefix() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async trackVisit(visitorId: string) {
    await this.prisma.visitorLog.upsert({
      where: { visitorId_date: { visitorId, date: todayStr() } },
      update: {},
      create: { visitorId, date: todayStr() },
    });
  }

  async getVisitorStats() {
    const [todayCount, weekRows, monthRows] = await Promise.all([
      this.prisma.visitorLog.count({ where: { date: todayStr() } }),
      this.prisma.visitorLog.findMany({
        where: { date: { gte: mondayStr() } },
        distinct: ['visitorId'],
        select: { visitorId: true },
      }),
      this.prisma.visitorLog.findMany({
        where: { date: { startsWith: monthPrefix() } },
        distinct: ['visitorId'],
        select: { visitorId: true },
      }),
    ]);
    return { today: todayCount, week: weekRows.length, month: monthRows.length };
  }

  /** Rol + staff kirilimi — bkz. Staff.userId iliskisi. */
  async getRoleCounts() {
    const [individual, accountant, staff] = await Promise.all([
      this.prisma.user.count({
        where: { role: 'INDIVIDUAL', staffRecord: { is: null } },
      }),
      this.prisma.user.count({
        where: { role: 'ACCOUNTANT', staffRecord: { is: null } },
      }),
      this.prisma.staff.count(),
    ]);
    return { individual, accountant, staff, total: individual + accountant + staff };
  }

  /** Son 5 dakikada istek atmis kullanicilar — gercek zamanli WebSocket
   *  presence yerine bilerek basit "lastSeenAt" yaklasimi (bkz.
   *  JwtStrategy.validate). Admin/staff, musavir, bireysel olarak
   *  gruplaniyor. */
  async getActiveUsers() {
    const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
    const users = await this.prisma.user.findMany({
      where: { lastSeenAt: { gte: since } },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        lastSeenAt: true,
        staffRecord: { select: { id: true } },
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    return {
      admin: users.filter((u) => u.staffRecord),
      accountant: users.filter((u) => !u.staffRecord && u.role === 'ACCOUNTANT'),
      individual: users.filter((u) => !u.staffRecord && u.role === 'INDIVIDUAL'),
    };
  }
}
