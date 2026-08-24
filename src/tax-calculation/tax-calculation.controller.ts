import {
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { TaxCalculationService } from './tax-calculation.service';

@UseGuards(JwtAuthGuard)
@Controller('tax-calculation')
export class TaxCalculationController {
  constructor(private readonly service: TaxCalculationService) {}

  @Post(':taxYear/calculate')
  // Agir bir islem (kullanicinin tum gecmisini yeniden isler) — siki limit.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  calculate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taxYear', ParseIntPipe) taxYear: number,
  ) {
    return this.service.calculateForYear(user.userId, taxYear);
  }
}
