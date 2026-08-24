import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { TransactionAggregationService } from './transaction-aggregation.service';
import { PrismaService } from '../prisma/prisma.service';

@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionAggregationController {
  constructor(
    private readonly service: TransactionAggregationService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('taxYear') taxYear?: string,
  ) {
    return this.service.listForUser(
      user.userId,
      taxYear ? Number(taxYear) : undefined,
    );
  }

  @Get('reconciliation-flags')
  listFlags(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.reconciliationFlag.findMany({
      where: { userId: user.userId, resolved: false },
      orderBy: { createdAt: 'desc' },
    });
  }
}
