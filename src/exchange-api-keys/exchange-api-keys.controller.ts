import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../auth/decorators/current-user.decorator';
import { ExchangeApiKeysService } from './exchange-api-keys.service';
import { CreateExchangeApiKeyDto } from './dto/create-exchange-api-key.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@UseGuards(JwtAuthGuard)
@Controller('exchange-api-keys')
export class ExchangeApiKeysController {
  constructor(private readonly service: ExchangeApiKeysService) {}

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExchangeApiKeyDto, @Req() req: Request) {
    return this.service.create(user.userId, dto, requestMeta(req));
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listForUser(user.userId);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Req() req: Request) {
    return this.service.remove(user.userId, id, requestMeta(req));
  }
}
