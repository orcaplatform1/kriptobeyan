import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
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
import { AccountantRoleGuard } from './guards/accountant-role.guard';
import { AccountantService } from './accountant.service';
import { InviteClientDto } from './dto/invite-client.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('accountant')
export class AccountantController {
  constructor(private readonly service: AccountantService) {}

  // Davet kabul: cagiran kisi henuz ACCOUNTANT olmayabilir (yeni musteri),
  // bu yuzden AccountantRoleGuard YOK — sadece giris yapmis olmasi yeterli.
  @UseGuards(JwtAuthGuard)
  @Post('invites/accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AcceptInviteDto,
    @Req() req: Request,
  ) {
    return this.service.acceptInvite(user.userId, dto.token, requestMeta(req));
  }

  @UseGuards(JwtAuthGuard, AccountantRoleGuard)
  @Post('clients/invite')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  inviteClient(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteClientDto,
    @Req() req: Request,
  ) {
    return this.service.inviteClient(user.userId, dto.email, requestMeta(req));
  }

  @UseGuards(JwtAuthGuard, AccountantRoleGuard)
  @Get('clients')
  listClients(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listClients(user.userId);
  }

  @UseGuards(JwtAuthGuard, AccountantRoleGuard)
  @Get('clients/overview')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.service.overview(user.userId);
  }

  @UseGuards(JwtAuthGuard, AccountantRoleGuard)
  @Get('clients/:clientUserId/summary')
  getClientSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('clientUserId') clientUserId: string,
  ) {
    return this.service.getClientSummary(user.userId, clientUserId);
  }

  @UseGuards(JwtAuthGuard, AccountantRoleGuard)
  @Delete('clients/:accountantClientId')
  removeClient(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountantClientId') accountantClientId: string,
    @Req() req: Request,
  ) {
    return this.service.removeClient(
      user.userId,
      accountantClientId,
      requestMeta(req),
    );
  }
}
