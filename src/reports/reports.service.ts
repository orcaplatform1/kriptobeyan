import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { ReportFormat } from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';

// process.cwd() kullaniliyor (__dirname DEGIL) — derlenmis kod dist/ altinda
// calisiyor ve `nest build` her seferinde dist/'i temizliyor; __dirname
// bazli bir yol storage/font klasorlerini her deploy'da SILERDI. PM2 bu
// servisi projenin kok dizininden (cwd) baslattigi icin process.cwd()
// guvenilir ve dist/'in disinda kaliyor.
const STORAGE_DIR = path.join(process.cwd(), 'storage', 'reports');
const FONT_REGULAR = path.join(
  process.cwd(),
  'assets',
  'fonts',
  'DejaVuSans.ttf',
);
const FONT_BOLD = path.join(
  process.cwd(),
  'assets',
  'fonts',
  'DejaVuSans-Bold.ttf',
);
const SHARE_TOKEN_BYTES = 24;
const APP_URL = process.env.APP_URL ?? 'https://kriptobeyan.com';

// TÜM rapor çıktılarında (PDF ve Excel, hem ekran hem indirilen dosya)
// bu uyarı MUTLAKA görünür olmalı — mali müşavir bu hesaplama mantığını
// (bkz. TaxCalculationService) henüz onaylamadı, kesin rakam gibi
// sunulamaz. Bu metni kaldırmak/gizlemek YASAK (yasal risk).
const DRAFT_WARNING =
  'TASLAK / TAHMİNİ HESAPLAMA — Bu rapor otomatik olarak hesaplanmıştır ve bir mali müşavir tarafından ' +
  'doğrulanmamıştır. Resmi beyan için kullanmadan önce mutlaka bir mali müşavire danışın.';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly mail: MailService,
  ) {}

  async generate(
    userId: string,
    taxYear: number,
    format: ReportFormat,
    meta: RequestMeta,
  ) {
    const [user, summary, transactions] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.taxYearSummary.findUnique({
        where: { userId_taxYear: { userId, taxYear } },
      }),
      this.prisma.transaction.findMany({
        where: {
          userId,
          taxYear,
          isInternalTransfer: false,
          isSpamFiltered: false,
        },
        orderBy: { timestamp: 'asc' },
      }),
    ]);

    if (!summary) {
      throw new BadRequestException(
        `${taxYear} için önce /tax-calculation/${taxYear}/calculate çalıştırılmalı`,
      );
    }

    fs.mkdirSync(path.join(STORAGE_DIR, userId), { recursive: true });
    const reportId = randomBytes(8).toString('hex');
    const ext = format === ReportFormat.PDF ? 'pdf' : 'xlsx';
    const fileName = `${taxYear}-${reportId}.${ext}`;
    const filePath = path.join(STORAGE_DIR, userId, fileName);

    if (format === ReportFormat.PDF) {
      await this.writePdf(filePath, user, taxYear, summary, transactions);
    } else {
      await this.writeExcel(filePath, user, taxYear, summary, transactions);
    }

    const report = await this.prisma.generatedReport.create({
      data: { userId, taxYear, format, filePath },
    });

    await this.auditLog.log({
      userId,
      action: 'REPORT_GENERATED',
      entity: 'GeneratedReport',
      entityId: report.id,
      metadata: { taxYear, format },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return report;
  }

  listForUser(userId: string) {
    return this.prisma.generatedReport.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Admin paneli — "rapor indiren kullanıcılar" listesi (kullanıcı adı + tarih). */
  listAllForAdmin() {
    return this.prisma.generatedReport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        taxYear: true,
        format: true,
        createdAt: true,
        user: { select: { id: true, username: true, email: true, fullName: true } },
      },
    });
  }

  async getOwnedFile(userId: string, reportId: string) {
    const report = await this.prisma.generatedReport.findUnique({
      where: { id: reportId },
    });
    if (!report || report.userId !== userId)
      throw new NotFoundException('Rapor bulunamadı');
    return report;
  }

  /** Mali müşavir paylaşım modu — link veya e-posta ile. */
  async share(
    userId: string,
    reportId: string,
    email: string | undefined,
    meta: RequestMeta,
  ) {
    const report = await this.getOwnedFile(userId, reportId);
    const shareToken =
      report.shareToken ?? randomBytes(SHARE_TOKEN_BYTES).toString('hex');
    const updated = await this.prisma.generatedReport.update({
      where: { id: reportId },
      data: {
        shareToken,
        sharedWithEmail: email ?? report.sharedWithEmail,
        expiresAt: new Date(Date.now() + 30 * 86_400_000), // 30 gün
      },
    });

    const shareUrl = `${APP_URL}/paylasilan-rapor/${shareToken}`;
    if (email) {
      await this.mail.send({
        to: email,
        subject: 'KriptoBeyan — Sizinle paylaşılan vergi raporu',
        html: `Sizinle bir KriptoBeyan raporu paylaşıldı: <a href="${shareUrl}">${shareUrl}</a> (30 gün geçerli). ${DRAFT_WARNING}`,
      });
    }

    await this.auditLog.log({
      userId,
      action: 'REPORT_SHARED',
      entity: 'GeneratedReport',
      entityId: reportId,
      metadata: { email },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return { shareUrl, expiresAt: updated.expiresAt };
  }

  async getByShareToken(shareToken: string) {
    const report = await this.prisma.generatedReport.findUnique({
      where: { shareToken },
    });
    if (!report || (report.expiresAt && report.expiresAt < new Date())) {
      throw new NotFoundException(
        'Paylaşım bağlantısı geçersiz veya süresi dolmuş',
      );
    }
    return report;
  }

  private async writePdf(
    filePath: string,
    user: { fullName: string | null; email: string },
    taxYear: number,
    summary: NonNullable<
      Awaited<ReturnType<PrismaService['taxYearSummary']['findUnique']>>
    >,
    transactions: Awaited<ReturnType<PrismaService['transaction']['findMany']>>,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Buyuk, gozden kacmayacak taslak uyarisi — kirmizi kutu.
      doc
        .rect(40, 40, doc.page.width - 80, 50)
        .fill('#FCEDF0')
        .stroke('#C94B55');
      doc
        .fillColor('#C94B55')
        .fontSize(11)
        .font(FONT_BOLD)
        .text(DRAFT_WARNING, 50, 55, { width: doc.page.width - 100 });

      doc.moveDown(3);
      doc
        .fillColor('black')
        .fontSize(18)
        .font(FONT_BOLD)
        .text(`KriptoBeyan — ${taxYear} Vergi Özeti`);
      doc
        .fontSize(10)
        .font(FONT_REGULAR)
        .fillColor('#555')
        .text(`${user.fullName ?? user.email} · ${user.email}`);
      doc.moveDown(1);

      doc.fontSize(11).fillColor('black').font(FONT_BOLD).text('Özet');
      doc.font(FONT_REGULAR).fontSize(10);
      const rows: [string, string][] = [
        [
          'Toplam gerçekleşen kâr',
          `${summary.totalRealizedGainTRY.toString()} TRY`,
        ],
        [
          'Toplam gerçekleşen zarar',
          `${summary.totalRealizedLossTRY.toString()} TRY`,
        ],
        ['Net sermaye kazancı', `${summary.netCapitalGainTRY.toString()} TRY`],
        [
          'Arızi kazanç (staking/airdrop/mining/LP)',
          `${summary.occasionalIncomeTRY.toString()} TRY`,
        ],
        [
          'Kullanılan istisna (sermaye kazancı)',
          `${summary.capitalGainsExemptionUsedTRY.toString()} TRY`,
        ],
        [
          'Kullanılan istisna (arızi kazanç)',
          `${summary.occasionalIncomeExemptionUsedTRY.toString()} TRY`,
        ],
        [
          'Tahmini vergiye tabi tutar',
          `${summary.estimatedTaxableAmountTRY.toString()} TRY`,
        ],
      ];
      for (const [label, value] of rows) {
        doc
          .text(`${label}: `, { continued: true })
          .font(FONT_BOLD)
          .text(value)
          .font(FONT_REGULAR);
      }

      doc.moveDown(1.5);
      doc
        .font(FONT_BOLD)
        .fontSize(11)
        .text(`İşlem Detayları (${transactions.length} işlem)`);
      doc.font(FONT_REGULAR).fontSize(8);
      doc.moveDown(0.5);
      for (const tx of transactions.slice(0, 500)) {
        doc.text(
          `${tx.timestamp.toISOString().slice(0, 10)}  ${tx.type.padEnd(14)}  ${tx.asset.padEnd(8)}  ` +
            `${tx.quantity.toString()}  ${tx.priceInQuote ? `@${tx.priceInQuote.toString()} ${tx.quoteCurrency ?? ''}` : ''}`,
        );
      }
      if (transactions.length > 500) {
        doc.text(
          `... ve ${transactions.length - 500} işlem daha (tam liste için Excel formatını kullanın)`,
        );
      }

      doc.end();
      stream.on('finish', () => resolve());
      stream.on('error', reject);
    });
  }

  private async writeExcel(
    filePath: string,
    user: { fullName: string | null; email: string },
    taxYear: number,
    summary: NonNullable<
      Awaited<ReturnType<PrismaService['taxYearSummary']['findUnique']>>
    >,
    transactions: Awaited<ReturnType<PrismaService['transaction']['findMany']>>,
  ): Promise<void> {
    const workbook = new ExcelJS.Workbook();

    const summarySheet = workbook.addWorksheet('Özet');
    summarySheet.getCell('A1').value = DRAFT_WARNING;
    summarySheet.getCell('A1').font = {
      bold: true,
      color: { argb: 'FFC94B55' },
    };
    summarySheet.getCell('A1').alignment = { wrapText: true };
    summarySheet.mergeCells('A1:D3');
    summarySheet.getRow(1).height = 60;

    summarySheet.getCell('A5').value = `KriptoBeyan — ${taxYear} Vergi Özeti`;
    summarySheet.getCell('A5').font = { bold: true, size: 14 };
    summarySheet.getCell('A6').value =
      `${user.fullName ?? user.email} (${user.email})`;

    const summaryRows: [string, string][] = [
      ['Toplam gerçekleşen kâr (TRY)', summary.totalRealizedGainTRY.toString()],
      [
        'Toplam gerçekleşen zarar (TRY)',
        summary.totalRealizedLossTRY.toString(),
      ],
      ['Net sermaye kazancı (TRY)', summary.netCapitalGainTRY.toString()],
      ['Arızi kazanç — staking/airdrop/mining/LP (TRY)', summary.occasionalIncomeTRY.toString()],
      [
        'Kullanılan istisna — sermaye kazancı (TRY)',
        summary.capitalGainsExemptionUsedTRY.toString(),
      ],
      [
        'Kullanılan istisna — arızi kazanç (TRY)',
        summary.occasionalIncomeExemptionUsedTRY.toString(),
      ],
      [
        'Tahmini vergiye tabi tutar (TRY)',
        summary.estimatedTaxableAmountTRY.toString(),
      ],
    ];
    let r = 8;
    for (const [label, value] of summaryRows) {
      summarySheet.getCell(`A${r}`).value = label;
      summarySheet.getCell(`B${r}`).value = value;
      r++;
    }
    summarySheet.columns = [{ width: 40 }, { width: 20 }];

    const txSheet = workbook.addWorksheet('İşlemler');
    txSheet.addRow([
      'Tarih',
      'Tip',
      'Varlık',
      'Miktar',
      'Fiyat',
      'Kur',
      'Kaynak',
      'İç Transfer mi',
    ]);
    txSheet.getRow(1).font = { bold: true };
    for (const tx of transactions) {
      txSheet.addRow([
        tx.timestamp.toISOString().slice(0, 10),
        tx.type,
        tx.asset,
        tx.quantity.toString(),
        tx.priceInQuote?.toString() ?? '',
        tx.quoteCurrency ?? '',
        tx.source,
        tx.isInternalTransfer ? 'Evet' : 'Hayır',
      ]);
    }
    txSheet.columns.forEach((col) => (col.width = 16));

    await workbook.xlsx.writeFile(filePath);
  }
}
