import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../crypto/crypto.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TransactionAggregationService } from '../transaction-aggregation/transaction-aggregation.service';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { CreateExchangeConnectionDto } from './dto/create-exchange-connection.dto';
import { SyncStatus, TransactionSource } from '../../generated/prisma/client';
import type { RequestMeta } from '../auth/auth.service';
import type { SyncJobData } from './sync.processor';

@Injectable()
export class ExchangeIntegrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly auditLog: AuditLogService,
    private readonly aggregation: TransactionAggregationService,
    private readonly adapters: AdapterRegistryService,
    @InjectQueue('sync') private readonly syncQueue: Queue<SyncJobData>,
  ) {}

  async create(
    userId: string,
    dto: CreateExchangeConnectionDto,
    meta: RequestMeta,
  ) {
    const connection = await this.prisma.exchangeConnection.create({
      data: {
        userId,
        provider: dto.provider,
        label: dto.label,
        encryptedApiKey: this.crypto.encrypt(dto.apiKey),
        encryptedApiSecret: this.crypto.encrypt(dto.apiSecret),
        encryptedPassphrase: dto.passphrase
          ? this.crypto.encrypt(dto.passphrase)
          : undefined,
        confirmedReadOnly: dto.confirmedReadOnly,
        confirmedReadOnlyAt: new Date(),
      },
    });

    await this.auditLog.log({
      userId,
      action: 'EXCHANGE_CONNECTION_CREATED',
      entity: 'ExchangeConnection',
      entityId: connection.id,
      metadata: { provider: dto.provider, label: dto.label },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    // Baglanti kurulur kurulmaz gercek izin seviyesini borsadan dogrulamayi
    // dene — WITHDRAW izni tespit edilirse kullanici derhal uyarilmali.
    void this.verifyPermission(userId, connection.id).catch(() => undefined);

    return this.toSafeShape(connection);
  }

  async verifyPermission(userId: string, id: string) {
    const connection = await this.getOwned(userId, id);
    const adapter = this.adapters.get(connection.provider);
    const credentials = {
      apiKey: this.crypto.decrypt(connection.encryptedApiKey),
      apiSecret: this.crypto.decrypt(connection.encryptedApiSecret),
      passphrase: connection.encryptedPassphrase
        ? this.crypto.decrypt(connection.encryptedPassphrase)
        : undefined,
    };
    const level = await adapter.verifyPermissionLevel(credentials);
    const updated = await this.prisma.exchangeConnection.update({
      where: { id },
      data: { verifiedPermissionLevel: level, verifiedAt: new Date() },
    });
    return this.toSafeShape(updated);
  }

  /** Kullanicidan gelen istek — is HEMEN kuyruga eklenir, HTTP istegi
   *  borsanin (potansiyel olarak yavas/sayfali) yanitini beklemez. Gercek
   *  is SyncProcessor.process() icinde performSync() cagrisiyla yapilir. */
  async sync(userId: string, id: string): Promise<{ queued: true }> {
    await this.getOwned(userId, id);
    await this.prisma.exchangeConnection.update({
      where: { id },
      data: { syncStatus: SyncStatus.SYNCING },
    });
    await this.syncQueue.add('exchange-sync', { kind: 'exchange', userId, id });
    return { queued: true };
  }

  /** Gercek senkronizasyon islemi — sadece SyncProcessor'dan (arka plan
   *  worker'i) cagrilir, HTTP request-response dongusunun disinda calisir. */
  async performSync(userId: string, id: string): Promise<number> {
    const connection = await this.getOwned(userId, id);
    const adapter = this.adapters.get(connection.provider);
    const credentials = {
      apiKey: this.crypto.decrypt(connection.encryptedApiKey),
      apiSecret: this.crypto.decrypt(connection.encryptedApiSecret),
      passphrase: connection.encryptedPassphrase
        ? this.crypto.decrypt(connection.encryptedPassphrase)
        : undefined,
    };

    try {
      const items = await adapter.fetchTransactions(
        credentials,
        connection.lastSyncedAt ?? undefined,
      );
      const inserted = await this.aggregation.ingest(
        userId,
        { source: TransactionSource.EXCHANGE_API, exchangeConnectionId: id },
        items,
      );
      await this.prisma.exchangeConnection.update({
        where: { id },
        data: {
          syncStatus: SyncStatus.SYNCED,
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });
      return inserted;
    } catch (err) {
      await this.prisma.exchangeConnection.update({
        where: { id },
        data: {
          syncStatus: SyncStatus.ERROR,
          lastSyncError: (err as Error).message,
        },
      });
      throw err;
    }
  }

  async listForUser(userId: string) {
    const connections = await this.prisma.exchangeConnection.findMany({
      where: { userId },
    });
    return connections.map((c) => this.toSafeShape(c));
  }

  async remove(userId: string, id: string, meta: RequestMeta) {
    await this.getOwned(userId, id);
    await this.prisma.exchangeConnection.delete({ where: { id } });
    await this.auditLog.log({
      userId,
      action: 'EXCHANGE_CONNECTION_DELETED',
      entity: 'ExchangeConnection',
      entityId: id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
  }

  private async getOwned(userId: string, id: string) {
    const connection = await this.prisma.exchangeConnection.findUnique({
      where: { id },
    });
    if (!connection || connection.userId !== userId) {
      throw new NotFoundException('Borsa bağlantısı bulunamadı');
    }
    return connection;
  }

  // API key/secret ASLA düz metin döndürülmez — sadece maskelenmiş halleri.
  private toSafeShape(c: {
    id: string;
    provider: string;
    label: string;
    encryptedApiKey: string;
    confirmedReadOnly: boolean;
    verifiedPermissionLevel: string;
    verifiedAt: Date | null;
    syncStatus: string;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
    createdAt: Date;
  }) {
    let maskedKey = '••••••••';
    try {
      const decrypted = this.crypto.decrypt(c.encryptedApiKey);
      maskedKey = `••••${decrypted.slice(-4)}`;
    } catch {
      // maskeleme basarisiz olsa bile gercek deger disari sizmaz
    }
    return {
      id: c.id,
      provider: c.provider,
      label: c.label,
      apiKeyMasked: maskedKey,
      confirmedReadOnly: c.confirmedReadOnly,
      verifiedPermissionLevel: c.verifiedPermissionLevel,
      verifiedAt: c.verifiedAt,
      syncStatus: c.syncStatus,
      lastSyncedAt: c.lastSyncedAt,
      lastSyncError: c.lastSyncError,
      createdAt: c.createdAt,
    };
  }
}
