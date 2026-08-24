import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../subscription/guards/admin.guard';
import { SiteContentService } from './site-content.service';

// Herkese acik - ana sayfa/footer bu veriyi kimlik dogrulamasi olmadan
// okuyabilmeli (bkz. lib/api.ts getSiteContent, sunucu tarafinda cagrilir).
@Controller('site-content')
export class SiteContentController {
  constructor(private readonly service: SiteContentService) {}

  @Get()
  get() {
    return this.service.getSiteContent();
  }
}

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin/site-content')
export class AdminSiteContentController {
  constructor(private readonly service: SiteContentService) {}

  @Get()
  get() {
    return this.service.getSiteContent();
  }

  @Patch()
  update(
    @Body()
    body: {
      heroBadge?: string;
      heroTitlePrefix?: string;
      heroTitleHighlight?: string;
      heroTitleSuffix?: string;
      heroDescription?: string;
      heroPrimaryCtaLabel?: string;
      heroSecondaryCtaLabel?: string;
      footerDescription?: string;
      footerCopyrightText?: string | null;
      footerSupportEmail?: string | null;
    },
  ) {
    return this.service.updateSiteContent(body);
  }
}
