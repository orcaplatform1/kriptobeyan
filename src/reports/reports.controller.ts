import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { ReportsService } from './reports.service';
import { ShareReportDto } from './dto/share-report.dto';
import { ReportFormat } from '../../generated/prisma/client';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

function contentType(format: ReportFormat) {
  return format === ReportFormat.PDF
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @UseGuards(JwtAuthGuard)
  @Post(':taxYear/generate')
  // PDF/Excel uretimi (tum islem gecmisini isliyor) — agir islem, siki limit.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('taxYear', ParseIntPipe) taxYear: number,
    @Query('format') format: ReportFormat,
    @Req() req: Request,
  ) {
    return this.service.generate(
      user.userId,
      taxYear,
      format ?? ReportFormat.PDF,
      requestMeta(req),
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.service.listForUser(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id/download')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const report = await this.service.getOwnedFile(user.userId, id);
    res.setHeader('Content-Type', contentType(report.format));
    fs.createReadStream(report.filePath).pipe(res);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/share')
  share(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ShareReportDto,
    @Req() req: Request,
  ) {
    return this.service.share(user.userId, id, dto.email, requestMeta(req));
  }

  // Mali müşavir paylaşım modu — link ile, GİRİŞ GEREKTİRMEZ (bilerek public,
  // token zaten yeterince rastgele/uzun — bkz. ReportsService.SHARE_TOKEN_BYTES).
  @Get('shared/:shareToken')
  async downloadShared(
    @Param('shareToken') shareToken: string,
    @Res() res: Response,
  ) {
    const report = await this.service.getByShareToken(shareToken);
    res.setHeader('Content-Type', contentType(report.format));
    fs.createReadStream(report.filePath).pipe(res);
  }
}
