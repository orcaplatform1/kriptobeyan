import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

const AiOpinionSchema = z.object({
  severity: z.enum(['info', 'warning', 'critical']),
  summary: z.string(),
  recommendations: z.array(z.string()),
});

export interface AiAuditFinding {
  type: string;
  description: string;
  createdAt: Date;
}

export interface AiAuditResult {
  status: 'clean' | 'issues';
  findings: AiAuditFinding[];
  ai: z.infer<typeof AiOpinionSchema> | null;
  // AI yorumu neden yok, ayirt etmek icin: key hic tanimli degilse UI
  // "AI Kontrolorü henuz aktif degil" gibi dogru bir mesaj gosterebilsin —
  // API cagrisi basarisiz oldu diye yanlis anlasilmasin.
  aiConfigured: boolean;
}

/**
 * Deterministik anomali tespiti + Claude'un bunlari sade Turkce'ye cevirmesi.
 *
 * ONEMLI SINIR: Claude burada vergi hesabinin DOGRULUGUNU denetlemiyor — bu
 * tamamen deterministik kod tarafinda (TaxCalculationService, Transaction
 * AggregationService) zaten yapiliyor ve ReconciliationFlag olarak
 * kaydediliyor. Claude'un tek isi: bu ONCEDEN TESPIT EDILMIS bulgulari
 * kullaniciya anlasilir Turkce'yle aciklamak/onceliklendirmek. Bulgu YOKSA
 * Claude hic cagrilmiyor (gereksiz maliyet/gecikme yok, "temiz" durumu
 * dogrudan kod tarafinda belirleniyor).
 */
@Injectable()
export class AiAuditService {
  private readonly logger = new Logger(AiAuditService.name);
  private readonly client: Anthropic | null;

  constructor(private readonly prisma: PrismaService) {
    this.client = process.env.ANTHROPIC_API_KEY
      ? new Anthropic()
      : null;
    if (!this.client) {
      this.logger.warn(
        'ANTHROPIC_API_KEY tanımlı değil — AI Kontrolörü deterministik bulguları gösterecek ama Türkçe yorum eklemeyecek',
      );
    }
  }

  async getAudit(userId: string, taxYear: number): Promise<AiAuditResult> {
    const yearStart = new Date(Date.UTC(taxYear, 0, 1));
    const yearEnd = new Date(Date.UTC(taxYear + 1, 0, 1));

    const [flags, exemptionConfig] = await Promise.all([
      this.prisma.reconciliationFlag.findMany({
        where: {
          userId,
          resolved: false,
          OR: [
            { transactionId: null },
            { transaction: { timestamp: { gte: yearStart, lt: yearEnd } } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.taxExemptionConfig.findUnique({ where: { taxYear } }),
    ]);

    const findings: AiAuditFinding[] = flags.map((f) => ({
      type: f.type,
      description: f.description,
      createdAt: f.createdAt,
    }));

    if (!exemptionConfig) {
      findings.push({
        type: 'MISSING_EXEMPTION_CONFIG',
        description: `${taxYear} yılı için istisna tutarları sistemde henüz tanımlanmamış — vergiye tabi tutar istisna düşülmeden (0 istisna ile) hesaplanmış olabilir.`,
        createdAt: new Date(),
      });
    }

    if (findings.length === 0) {
      return { status: 'clean', findings: [], ai: null, aiConfigured: this.client != null };
    }

    if (!this.client) {
      return { status: 'issues', findings, ai: null, aiConfigured: false };
    }

    try {
      const response = await this.client.messages.parse({
        model: 'claude-opus-5',
        max_tokens: 4096,
        system:
          'Sen KriptoBeyan uygulamasında kullanıcının kripto vergi raporunu inceleyen "Yapay Zeka Kontrolörü" ' +
          'kutusunu dolduruyorsun. Sana verilen bulgular ZATEN deterministik/kural tabanlı kontrollerle tespit ' +
          'edilmiş veri kalitesi sorunlarıdır — bunları SEN keşfetmedin, sadece yorumluyorsun. Görevin: bu ' +
          'bulguları normal bir kullanıcının (muhasebeci değil) anlayacağı sade Türkçe ile özetlemek, önem ' +
          'sırasına koymak ve somut, uygulanabilir öneriler vermek (ör. "eksik cüzdanını ekle", "şu işlemi ' +
          'gözden geçir"). Vergi hesabının matematiğini kendin doğrulamaya ÇALIŞMA — sadece bu bulgular hakkında ' +
          'konuş. Gereksiz alarm oluşturma, ölçülü ve net ol.',
        messages: [
          {
            role: 'user',
            content: `Vergi yılı: ${taxYear}\n\nBulgular:\n${findings
              .map((f) => `- [${f.type}] ${f.description}`)
              .join('\n')}`,
          },
        ],
        output_config: { format: zodOutputFormat(AiOpinionSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) {
        this.logger.warn(
          `AI Kontrolörü: yapılandırılmış çıktı ayrıştırılamadı (userId=${userId}, taxYear=${taxYear})`,
        );
        return { status: 'issues', findings, ai: null, aiConfigured: true };
      }
      return { status: 'issues', findings, ai: parsed, aiConfigured: true };
    } catch (err) {
      this.logger.warn(`AI Kontrolörü çağrısı başarısız: ${(err as Error).message}`);
      return { status: 'issues', findings, ai: null, aiConfigured: true };
    }
  }
}
