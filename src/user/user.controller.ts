import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { UserService } from './user.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateTaxSettingsDto } from './dto/update-tax-settings.dto';
import { SetActiveTaxYearDto } from './dto/set-active-tax-year.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@UseGuards(JwtAuthGuard)
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.userService.getProfile(user.userId);
  }

  @Patch('me')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.userService.updateProfile(user.userId, dto);
  }

  @Patch('me/tax-settings')
  updateTaxSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateTaxSettingsDto,
    @Req() req: Request,
  ) {
    return this.userService.updateTaxSettings(
      user.userId,
      dto,
      requestMeta(req),
    );
  }

  @Patch('me/active-tax-year')
  setActiveTaxYear(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetActiveTaxYearDto,
  ) {
    return this.userService.setActiveTaxYear(user.userId, dto.taxYear);
  }

  @Patch('me/notification-preferences')
  updateNotificationPreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.userService.updateNotificationPreferences(user.userId, dto);
  }
}
