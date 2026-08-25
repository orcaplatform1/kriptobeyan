import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import { ReportsService } from './reports.service';

// Admin panelinde "rapor indiren kullanıcılar" listesi - kullanıcı adı +
// rapor tarihi, kullanıcı profiline (UserDetailPanel) tıklanabilir şekilde
// (kullanıcı istegi 2026-08-25). Dosya İÇERİĞİ döndürmez - sadece metadata.
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  listAll() {
    return this.service.listAllForAdmin();
  }
}
