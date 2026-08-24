import { Controller, Get, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { AiAuditService } from './ai-audit.service';

@UseGuards(JwtAuthGuard)
@Controller('ai-audit')
export class AiAuditController {
  constructor(private readonly service: AiAuditService) {}

  @Get(':taxYear')
  // Bulgu varsa Claude API'sini cagirir (maliyetli) — asiri kullanimi
  // sinirla.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  getAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taxYear', ParseIntPipe) taxYear: number,
  ) {
    return this.service.getAudit(user.userId, taxYear);
  }
}
