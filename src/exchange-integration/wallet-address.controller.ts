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
import { WalletAddressService } from './wallet-address.service';
import { AddWalletAddressDto } from './dto/add-wallet-address.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@UseGuards(JwtAuthGuard)
@Controller('wallet-addresses')
export class WalletAddressController {
  constructor(private readonly service: WalletAddressService) {}

  @Post()
  add(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddWalletAddressDto,
    @Req() req: Request,
  ) {
    return this.service.add(user.userId, dto, requestMeta(req));
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listForUser(user.userId);
  }

  @Post(':id/sync')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sync(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.sync(user.userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.remove(user.userId, id);
  }
}
