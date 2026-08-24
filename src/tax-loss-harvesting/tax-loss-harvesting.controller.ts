import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { TaxLossHarvestingService } from './tax-loss-harvesting.service';

@UseGuards(JwtAuthGuard)
@Controller('tax-loss-harvesting')
export class TaxLossHarvestingController {
  constructor(private readonly service: TaxLossHarvestingService) {}

  @Get('opportunities')
  // Her varlik icin fiyat API'sine gidiyor — siki limit.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  getOpportunities(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getOpportunities(user.userId);
  }
}
