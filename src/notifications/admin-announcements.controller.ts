import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import { NotificationsService } from './notifications.service';
import { UserRole } from '../../generated/prisma/client';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async send(@Body('message') message: string, @Body('role') role?: UserRole) {
    const trimmed = (message ?? '').trim();
    if (!trimmed) return { sent: 0 };
    const sent = await this.notifications.broadcast(trimmed, role);
    return { sent };
  }
}
