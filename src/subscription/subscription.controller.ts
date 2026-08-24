import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
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

  // Havale/EFT dekontu veya kripto islem kaniti — createPayment'tan ONCE
  // cagrilir, donen `key` receiptUrl olarak gonderilir (bkz. PaymentService
  // yorumu, ORCA'daki iki adimli upload+create deseniyle ayni).
  @UseGuards(JwtAuthGuard)
  @Post('payments/receipt')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  uploadReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.payments.uploadReceipt(user.userId, file);
  }

  @UseGuards(JwtAuthGuard)
  @Post('payments/:id/receipt')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  async attachReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const { key } = await this.payments.uploadReceipt(user.userId, file);
    return this.payments.attachReceipt(user.userId, id, key);
  }

  @UseGuards(JwtAuthGuard)
  @Get('payments/:id/receipt')
  async downloadReceipt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const filePath = await this.payments.getReceiptFile(user.userId, id);
    res.sendFile(filePath);
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
      {
        cryptoProvider: dto.cryptoProvider,
        cryptoAsset: dto.cryptoAsset,
        receiptUrl: dto.receiptUrl,
        couponCode: dto.couponCode,
      },
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

  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('payments/:id/reject')
  rejectPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.payments.reject(id, user.userId, requestMeta(req));
  }
}
