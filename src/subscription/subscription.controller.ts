import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { PlanService } from './plan.service';
import { SubscriptionService } from './subscription.service';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UserRole } from '../../generated/prisma/client';
import { AdminGuard } from './guards/admin.guard';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly plans: PlanService,
    private readonly subscriptions: SubscriptionService,
    private readonly payments: PaymentService,
  ) {}

  // Fiyatlandirma sayfasi girissiz goruntulenebilmeli — guard YOK.
  @Get('plans')
  listPlans(@Query('type') type?: UserRole) {
    return this.plans.listActive(type);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  myUsage(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptions.getUsageSummary(user.userId, user.role);
  }

  @UseGuards(JwtAuthGuard)
  @Post('payments')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  createPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
    @Req() req: Request,
  ) {
    return this.payments.createPayment(
      user.userId,
      dto.planId,
      dto.method,
      requestMeta(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('payments')
  listPayments(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.listForUser(user.userId);
  }

  // ADMIN ONAYI GEREKIR — herhangi bir giris yapmis kullanici degil (bkz.
  // AdminGuard). Bu olmadan bir kullanici kendi odemesini "tamamlandi"
  // isaretleyip odeme yapmadan abonelik alabilirdi.
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('payments/:id/mark-completed')
  // TODO: gercek gateway baglaninca bu admin-manuel uc nokta kaldirilip
  // webhook handler ile degistirilecek (bkz. PaymentService yorumu).
  markCompleted(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.payments.markCompleted(id, user.userId, requestMeta(req));
  }
}
