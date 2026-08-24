import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Tek satirlik singleton (AutoTradeConfig/ScannerConfig ile ayni desen,
// bkz. traders.tr ScannerService.getScannerConfig). Kayit yoksa varsayilan
// degerlerle (Prisma schema'daki @default'lar) bir tane olusturulur - bu
// varsayilanlar bilesenlerde eskiden SABIT yazili olan metinlerin BIREBIR
// aynisi, yani ilk kurulumda gorunumde hicbir degisiklik olmaz.
@Injectable()
export class SiteContentService {
  constructor(private readonly prisma: PrismaService) {}

  async getSiteContent() {
    const existing = await this.prisma.siteContentSettings.findFirst();
    if (existing) return existing;
    return this.prisma.siteContentSettings.create({ data: {} });
  }

  async updateSiteContent(data: {
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
  }) {
    const config = await this.getSiteContent();
    return this.prisma.siteContentSettings.update({
      where: { id: config.id },
      data,
    });
  }
}
