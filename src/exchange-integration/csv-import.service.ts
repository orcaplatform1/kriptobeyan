import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionAggregationService } from '../transaction-aggregation/transaction-aggregation.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  CsvImportStatus,
  TransactionSource,
  TransactionType,
} from '../../generated/prisma/client';
import type { NormalizedExchangeTransaction } from './adapters/exchange-adapter.interface';
import type { RequestMeta } from '../auth/auth.service';

// KriptoBeyan'in beklediği CSV şablonu (API'si olmayan/desteklenmeyen
// platformlar için manuel yükleme). Sütun adları büyük/küçük harfe
// duyarsız. Frontend'de indirilebilir örnek şablon olarak sunulmalı.
//
// date, type, asset, quantity, price, quoteCurrency, feeAmount, feeAsset
// 2025-03-15T10:00:00Z, BUY, BTC, 0.01, 1850000, TRY, 5, TRY
const REQUIRED_COLUMNS = ['date', 'type', 'asset', 'quantity'];
const VALID_TYPES = new Set(Object.values(TransactionType));

@Injectable()
export class CsvImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: TransactionAggregationService,
    private readonly auditLog: AuditLogService,
  ) {}

  async importCsv(
    userId: string,
    exchangeName: string,
    fileName: string,
    buffer: Buffer,
    meta: RequestMeta,
  ) {
    let rows: Record<string, string>[];
    try {
      rows = parse(buffer, {
        columns: (header: string[]) =>
          header.map((h) => h.trim().toLowerCase()),
        skip_empty_lines: true,
        trim: true,
      });
    } catch (err) {
      throw new BadRequestException(
        `CSV ayrıştırılamadı: ${(err as Error).message}`,
      );
    }

    if (rows.length === 0) throw new BadRequestException('CSV boş');
    const columns = Object.keys(rows[0]);
    const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
    if (missing.length > 0) {
      throw new BadRequestException(
        `CSV'de eksik sütun(lar): ${missing.join(', ')}`,
      );
    }

    const csvImport = await this.prisma.csvImport.create({
      data: {
        userId,
        exchangeName,
        fileName,
        rowCount: rows.length,
        status: CsvImportStatus.PENDING,
      },
    });

    try {
      const items: NormalizedExchangeTransaction[] = [];
      const errors: string[] = [];
      rows.forEach((row, idx) => {
        try {
          items.push(this.mapRow(row));
        } catch (err) {
          errors.push(`Satır ${idx + 2}: ${(err as Error).message}`);
        }
      });

      const inserted = await this.aggregation.ingest(
        userId,
        { source: TransactionSource.CSV, csvImportId: csvImport.id },
        items,
      );

      await this.prisma.csvImport.update({
        where: { id: csvImport.id },
        data: {
          status:
            errors.length > 0 && inserted === 0
              ? CsvImportStatus.FAILED
              : CsvImportStatus.PROCESSED,
          importedCount: inserted,
          errorMessage:
            errors.length > 0 ? errors.slice(0, 20).join('\n') : null,
        },
      });

      await this.auditLog.log({
        userId,
        action: 'CSV_IMPORTED',
        entity: 'CsvImport',
        entityId: csvImport.id,
        metadata: {
          exchangeName,
          rowCount: rows.length,
          imported: inserted,
          errorCount: errors.length,
        },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });

      return { csvImportId: csvImport.id, imported: inserted, errors };
    } catch (err) {
      await this.prisma.csvImport.update({
        where: { id: csvImport.id },
        data: {
          status: CsvImportStatus.FAILED,
          errorMessage: (err as Error).message,
        },
      });
      throw err;
    }
  }

  private mapRow(row: Record<string, string>): NormalizedExchangeTransaction {
    const type = row.type?.toUpperCase();
    if (!type || !VALID_TYPES.has(type as TransactionType)) {
      throw new Error(
        `geçersiz işlem tipi "${row.type}" (izin verilenler: ${[...VALID_TYPES].join(', ')})`,
      );
    }
    const timestamp = new Date(row.date);
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error(`geçersiz tarih "${row.date}"`);
    }
    if (!row.asset) throw new Error('asset boş olamaz');
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0)
      throw new Error(`geçersiz miktar "${row.quantity}"`);

    // Rastgelelik KULLANILMIYOR — ayni CSV iki kez yuklenirse (kullanici
    // yanlislikla tekrar yuklerse) satirlar deterministik ayni externalId'yi
    // uretip Transaction'daki unique kisitlamayla otomatik dedupe edilsin diye.
    return {
      externalId: `csv-row-${timestamp.getTime()}-${row.asset}-${type}-${row.quantity}-${row.price ?? ''}`,
      type: type as TransactionType,
      asset: row.asset.toUpperCase(),
      quantity: String(quantity),
      priceInQuote: row.price ? String(Number(row.price)) : undefined,
      quoteCurrency: row.quotecurrency || undefined,
      feeAmount: row.feeamount ? String(Number(row.feeamount)) : undefined,
      feeAsset: row.feeasset || undefined,
      timestamp,
      raw: row,
    };
  }
}
