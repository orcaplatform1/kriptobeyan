import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { VerifyTwoFactorDto, DisableTwoFactorDto } from './dto/two-factor.dto';
import {
  ResendVerificationDto,
  VerifyEmailDto,
} from './dto/email-verification.dto';
import { VerifyPhoneDto } from './dto/phone-verification.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from './decorators/current-user.decorator';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  // Kayit uc noktasi da brute-force/spam hesap acmaya karsi siki limitli.
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, requestMeta(req));
  }

  @Post('login')
  // Login endpoint'i ozellikle siki: dakikada 5 deneme (IP bazli, ThrottlerGuard).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, requestMeta(req));
  }

  @Post('refresh')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, requestMeta(req));
  }

  @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Post('verify-email')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    return this.auth.verifyEmail(dto.token, requestMeta(req));
  }

  @Post('resend-verification')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.auth.resendVerificationEmail(dto.email);
  }

  @UseGuards(JwtAuthGuard)
  @Post('phone/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verifyPhone(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyPhoneDto,
    @Req() req: Request,
  ) {
    return this.auth.verifyPhone(user.userId, dto.code, requestMeta(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('phone/resend-code')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  resendPhoneCode(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.resendPhoneVerificationCode(user.userId);
  }

  @Post('request-password-reset')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
    @Req() req: Request,
  ) {
    return this.auth.requestPasswordReset(dto.email, requestMeta(req));
  }

  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.auth.resetPassword(
      dto.token,
      dto.newPassword,
      requestMeta(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/generate')
  generateTwoFactor(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.generateTwoFactorSecret(user.userId, user.email);
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/enable')
  enableTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyTwoFactorDto,
    @Req() req: Request,
  ) {
    return this.auth.enableTwoFactor(user.userId, dto.code, requestMeta(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('2fa/disable')
  disableTwoFactor(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DisableTwoFactorDto,
    @Req() req: Request,
  ) {
    return this.auth.disableTwoFactor(
      user.userId,
      dto.password,
      dto.code,
      requestMeta(req),
    );
  }
}
