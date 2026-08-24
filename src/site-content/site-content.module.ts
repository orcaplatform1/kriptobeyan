import { Module } from '@nestjs/common';
import { SiteContentService } from './site-content.service';
import {
  SiteContentController,
  AdminSiteContentController,
} from './site-content.controller';

@Module({
  controllers: [SiteContentController, AdminSiteContentController],
  providers: [SiteContentService],
})
export class SiteContentModule {}
