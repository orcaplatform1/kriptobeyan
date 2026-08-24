import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CouponsService } from './coupons.service';

@UseGuards(JwtAuthGuard)
@Controller('accountant/coupon')
export class CouponsController {
  constructor(private readonly service: CouponsService) {}

  @Get()
  getMine(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getMyCoupon(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.service.createMyCoupon(user.userId);
  }
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/coupons')
export class AdminCouponsController {
  constructor(private readonly service: CouponsService) {}

  @Get()
  list() {
    return this.service.listAllForAdmin();
  }

  @Post(':id/active')
  setActive(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.service.setActive(id, isActive);
  }
}
