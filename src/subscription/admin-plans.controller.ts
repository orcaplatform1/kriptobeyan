import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { AdminGuard } from './guards/admin.guard';
import { PlanService } from './plan.service';
import { UpdatePlanDto } from './dto/update-plan.dto';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

// Manage panelinde plan fiyat/limit düzenleme ekranı için — bkz. AdminGuard
// yorumundaki bootstrap notu.
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/plans')
export class AdminPlansController {
  constructor(private readonly plans: PlanService) {}

  @Get()
  list() {
    return this.plans.listAll();
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @Req() req: Request,
  ) {
    return this.plans.update(id, dto, user.userId, requestMeta(req));
  }
}
