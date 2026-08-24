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
import { ExchangeIntegrationService } from './exchange-integration.service';
import { CreateExchangeConnectionDto } from './dto/create-exchange-connection.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@UseGuards(JwtAuthGuard)
@Controller('exchange-connections')
export class ExchangeIntegrationController {
  constructor(private readonly service: ExchangeIntegrationService) {}

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExchangeConnectionDto,
    @Req() req: Request,
  ) {
    return this.service.create(user.userId, dto, requestMeta(req));
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listForUser(user.userId);
  }

  @Post(':id/verify-permission')
  // Borsa API'sine gidiyor — asiri istekten korumak icin siki limit.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  verifyPermission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.service.verifyPermission(user.userId, id);
  }

  @Post(':id/sync')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  sync(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.sync(user.userId, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.remove(user.userId, id, requestMeta(req));
  }
}
