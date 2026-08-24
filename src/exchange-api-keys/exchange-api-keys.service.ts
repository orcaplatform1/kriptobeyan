import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateExchangeApiKeyDto } from './dto/create-exchange-api-key.dto';
import type { RequestMeta } from '../auth/auth.service';

// Not: Borsa API key/secret ASLA duz metin donmez — liste/detay uc noktalari
// sadece maskelenmis (son 4 karakter) hallerini dondurur. Cozulmus (decrypted)
// deger yalnizca sunucu icinde, gercekten borsaya istek atilacagi an
// kullanilmali (bu proje henuz borsaya istek atmiyor, o yuzden decrypt eden
// bir "kullan" metodu simdilik yok — ileride eklenince audit log'lanmali).
@Injectable()
export class ExchangeApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(userId: string, dto: CreateExchangeApiKeyDto, meta: RequestMeta) {
    const record = await this.prisma.exchangeApiKey.create({
      data: {
        userId,
        exchange: dto.exchange,
        label: dto.label,
        encryptedApiKey: this.crypto.encrypt(dto.apiKey),
        encryptedApiSecret: this.crypto.encrypt(dto.apiSecret),
        confirmedReadOnly: dto.confirmedReadOnly,
        confirmedReadOnlyAt: new Date(),
      },
    });

    await this.auditLog.log({
      userId,
      action: 'API_KEY_CREATED',
      entity: 'ExchangeApiKey',
      entityId: record.id,
      metadata: { exchange: dto.exchange, label: dto.label },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return this.toMasked(record);
  }

  async listForUser(userId: string) {
    const records = await this.prisma.exchangeApiKey.findMany({ where: { userId } });
    return records.map((r) => this.toMasked(r));
  }

  async remove(userId: string, id: string, meta: RequestMeta) {
    const record = await this.prisma.exchangeApiKey.findUnique({ where: { id } });
    if (!record || record.userId !== userId) {
      throw new NotFoundException('API key bulunamadı');
    }
    await this.prisma.exchangeApiKey.delete({ where: { id } });
    await this.auditLog.log({
      userId,
      action: 'API_KEY_DELETED',
      entity: 'ExchangeApiKey',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  private toMasked(record: {
    id: string;
    exchange: string;
    label: string;
    encryptedApiKey: string;
    confirmedReadOnly: boolean;
    createdAt: Date;
  }) {
    let maskedKey = '••••••••';
    try {
      const decrypted = this.crypto.decrypt(record.encryptedApiKey);
      maskedKey = `••••${decrypted.slice(-4)}`;
    } catch {
      // maskeleme basarisiz olsa bile hicbir gercek deger disari sizmaz
    }
    return {
      id: record.id,
      exchange: record.exchange,
      label: record.label,
      apiKeyMasked: maskedKey,
      confirmedReadOnly: record.confirmedReadOnly,
      createdAt: record.createdAt,
    };
  }
}
