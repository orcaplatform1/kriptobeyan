import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { AdminGuard } from '../subscription/guards/admin.guard';
import { AdminUsersService } from './admin-users.service';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UserRole } from '../../generated/prisma/client';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

// Manage panelinde kullanici yonetimi ekrani icin — bkz. AdminGuard
// yorumundaki bootstrap notu.
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  list(
    @Query('role') role?: UserRole,
    @Query('staffOnly') staffOnly?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({
      role,
      staffOnly: staffOnly === 'true',
      search,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.service.getOne(id);
  }

  @Patch(':id')
  update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
    @Req() req: Request,
  ) {
    return this.service.update(admin.userId, id, dto, requestMeta(req));
  }

  @Post(':id/staff')
  grantStaff(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.grantStaff(admin.userId, id, requestMeta(req));
  }

  @Delete(':id/staff')
  revokeStaff(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.revokeStaff(admin.userId, id, requestMeta(req));
  }

  @Delete(':id')
  remove(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    return this.service.remove(admin.userId, id, requestMeta(req));
  }
}
