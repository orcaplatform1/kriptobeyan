import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import { CsvImportService } from './csv-import.service';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10MB

@UseGuards(JwtAuthGuard)
@Controller('csv-imports')
export class CsvImportController {
  constructor(private readonly service: CsvImportService) {}

  @Post()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES } }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('exchangeName') exchangeName: string,
    @Req() req: Request,
  ) {
    if (!file)
      throw new BadRequestException('Dosya bulunamadı (form alanı: file)');
    if (!exchangeName) throw new BadRequestException('exchangeName zorunlu');
    return this.service.importCsv(
      user.userId,
      exchangeName,
      file.originalname,
      file.buffer,
      requestMeta(req),
    );
  }
}
