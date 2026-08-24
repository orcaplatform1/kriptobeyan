import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Baslangic listesi — bilinen scam/airdrop-spam token sembolleri. Gercek
// urunde CoinGecko'nun spam isaretlemesi (ör. /coins/list?include_platform=true
// + community/spam skorlari) veya benzer acik kaynak listelerle periyodik
// guncellenmeli (bkz. refreshFromCoinGecko — simdilik iskelet, CoinGecko'nun
// spam-token uc noktasi hesap/plan gerektirebilir, dogrulanmadi).
const SEED_SPAM_SYMBOLS = [
  'SAFEMOON2',
  'ELONDOGE',
  'FREEAIRDROP',
  'CLAIMREWARD',
  'VISIT-SITE',
];

@Injectable()
export class SpamFilterService implements OnModuleInit {
  private readonly logger = new Logger(SpamFilterService.name);
  private cache = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedIfEmpty();
    await this.reloadCache();
  }

  private async seedIfEmpty() {
    const count = await this.prisma.spamToken.count();
    if (count > 0) return;
    await this.prisma.spamToken.createMany({
      data: SEED_SPAM_SYMBOLS.map((asset) => ({ asset, source: 'seed-list' })),
      skipDuplicates: true,
    });
    this.logger.log(
      `Spam token listesi ${SEED_SPAM_SYMBOLS.length} baslangic kaydiyla dolduruldu`,
    );
  }

  private async reloadCache() {
    const tokens = await this.prisma.spamToken.findMany({
      select: { asset: true },
    });
    this.cache = new Set(tokens.map((t) => t.asset.toUpperCase()));
  }

  isSpam(asset: string): Promise<boolean> {
    return Promise.resolve(this.cache.has(asset.toUpperCase()));
  }

  async addToList(asset: string, reason: string, source = 'manual') {
    const existing = await this.prisma.spamToken.findFirst({
      where: { asset, chain: null },
    });
    if (existing) {
      await this.prisma.spamToken.update({
        where: { id: existing.id },
        data: { reason, source },
      });
    } else {
      await this.prisma.spamToken.create({ data: { asset, reason, source } });
    }
    await this.reloadCache();
  }

  async listAll() {
    return this.prisma.spamToken.findMany({ orderBy: { addedAt: 'desc' } });
  }
}
