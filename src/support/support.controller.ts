import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { SupportService } from './support.service';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { AddMessageDto } from './dto/add-message.dto';
import { SupportTicketStatus } from '../../generated/prisma/client';

@UseGuards(JwtAuthGuard)
@Controller('support/tickets')
export class SupportController {
  constructor(private readonly service: SupportService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTicketDto,
  ) {
    return this.service.createTicket(user.userId, dto.subject, dto.body);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listForUser(user.userId);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getOwnedTicket(user.userId, id);
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  addMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddMessageDto,
  ) {
    return this.service.addMessage(user.userId, id, dto.body, false);
  }
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/support/tickets')
export class AdminSupportController {
  constructor(private readonly service: SupportService) {}

  @Get()
  list(@Query('status') status?: SupportTicketStatus) {
    return this.service.listForAdmin(status);
  }

  @Get(':id')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getOwnedTicket(user.userId, id, true);
  }

  @Post(':id/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddMessageDto,
  ) {
    return this.service.addMessage(user.userId, id, dto.body, true);
  }

  @Post(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: SupportTicketStatus,
  ) {
    return this.service.updateStatus(id, status);
  }
}
