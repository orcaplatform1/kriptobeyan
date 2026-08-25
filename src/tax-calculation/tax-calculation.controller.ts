import {
  Controller,
  ForbiddenException,
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
import { SubscriptionService } from '../subscription/subscription.service';

@UseGuards(JwtAuthGuard)
@Controller('tax-calculation')
export class TaxCalculationController {
  constructor(
    private readonly service: TaxCalculationService,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  @Post(':taxYear/calculate')
  // Agir bir islem (kullanicinin tum gecmisini yeniden isler) — siki limit.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async calculate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taxYear', ParseIntPipe) taxYear: number,
  ) {
    const access = await this.subscriptionService.checkTransactionLimit(
      user.userId,
      taxYear,
    );
    if (!access.allowed) {
      const recommended = await this.subscriptionService.recommendPlan(access.used);
      throw new ForbiddenException({
        error: 'PLAN_REQUIRED',
        message: `${taxYear} yili icin ${access.used} islemin var, ucretsiz hesaplama siniri ${access.limit}. Devam etmek icin islem sayina uygun bir plana gecmelisin.`,
        used: access.used,
        limit: access.limit,
        recommendedPlanId: recommended?.id ?? null,
        recommendedPlanName: recommended?.name ?? null,
      });
    }
    return this.service.calculateForYear(user.userId, taxYear);
  }
}
