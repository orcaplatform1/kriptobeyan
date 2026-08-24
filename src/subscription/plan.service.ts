import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../../generated/prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import type { RequestMeta } from '../auth/auth.service';

interface UpdatePlanInput {
  priceTRY?: number;
  transactionLimit?: number | null;
  clientLimit?: number | null;
  isActive?: boolean;
}

@Injectable()
export class PlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  listActive(type?: UserRole) {
    return this.prisma.plan.findMany({
      where: { isActive: true, ...(type ? { type } : {}) },
      orderBy: { priceTRY: 'asc' },
    });
  }

  // Manage panelinde admin ekranı için — pasif planlar da dahil tüm liste.
  listAll() {
    return this.prisma.plan.findMany({
      orderBy: [{ type: 'asc' }, { priceTRY: 'asc' }],
    });
  }

  async update(
    planId: string,
    input: UpdatePlanInput,
    adminUserId: string,
    meta: RequestMeta,
  ) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Plan bulunamadı');

    const updated = await this.prisma.plan.update({
      where: { id: planId },
      data: input,
    });
    await this.auditLog.log({
      userId: adminUserId,
      action: 'PLAN_UPDATED',
      entity: 'Plan',
      entityId: planId,
      metadata: { planName: plan.name, changes: { ...input } },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return updated;
  }
}
