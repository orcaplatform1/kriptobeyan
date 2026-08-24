import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { DashboardService } from './dashboard.service';

@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('taxYear') taxYear: string,
  ) {
    const year = taxYear ? Number(taxYear) : new Date().getUTCFullYear();
    return this.service.getRealizedOverview(user.userId, year);
  }

  @Get('positions')
  getPositions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('asset') asset?: string,
    @Query('exchangeConnectionId') exchangeConnectionId?: string,
  ) {
    return this.service.getPositions(user.userId, {
      asset,
      exchangeConnectionId,
    });
  }

  @Get('sources')
  listSources(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listSources(user.userId);
  }
}
