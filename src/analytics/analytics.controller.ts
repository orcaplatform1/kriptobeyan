import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  // Girissiz — anonim ziyaretci sayaci, herkes tetikleyebilir (bkz.
  // AnalyticsService.trackVisit, kisisel veri icermez).
  @Post('track')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  track(@Body('visitorId') visitorId: string) {
    if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) {
      return { ok: false };
    }
    return this.service.trackVisit(visitorId).then(() => ({ ok: true }));
  }
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('visitors')
  visitors() {
    return this.service.getVisitorStats();
  }

  @Get('roles')
  roles() {
    return this.service.getRoleCounts();
  }

  @Get('active-users')
  activeUsers() {
    return this.service.getActiveUsers();
  }
}
