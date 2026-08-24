import {
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../auth/decorators/current-user.decorator';
import {
  AccountantVerificationService,
  type DocKind,
} from './accountant-verification.service';

function requestMeta(req: Request) {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@UseGuards(JwtAuthGuard)
@Controller('accountant/verification')
export class AccountantVerificationController {
  constructor(private readonly service: AccountantVerificationService) {}

  @Post('documents')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'license', maxCount: 1 },
      { name: 'taxPlate', maxCount: 1 },
    ]),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles()
    files: { license?: Express.Multer.File[]; taxPlate?: Express.Multer.File[] },
    @Req() req: Request,
  ) {
    return this.service.uploadDocuments(user.userId, files, requestMeta(req));
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getStatus(user.userId);
  }

  @Get('documents/:kind')
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind') kind: DocKind,
    @Res() res: Response,
  ) {
    const filePath = await this.service.getDocumentFile(user.userId, user.userId, kind);
    res.sendFile(filePath);
  }
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/accountant-verifications')
export class AdminAccountantVerificationController {
  constructor(private readonly service: AccountantVerificationService) {}

  @Get()
  list() {
    return this.service.listPending();
  }

  @Get(':userId/documents/:kind')
  async download(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId') userId: string,
    @Param('kind') kind: DocKind,
    @Res() res: Response,
  ) {
    const filePath = await this.service.getDocumentFile(admin.userId, userId, kind);
    res.sendFile(filePath);
  }

  @Post(':userId/approve')
  approve(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.service.approve(admin.userId, userId, requestMeta(req));
  }

  @Post(':userId/reject')
  reject(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.service.reject(admin.userId, userId, requestMeta(req));
  }
}
