import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionAggregationService } from '../transaction-aggregation/transaction-aggregation.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EthereumLikeClient } from './onchain/ethereum-like.client';
import { BitcoinClient } from './onchain/bitcoin.client';
import {
  WalletChain,
  SyncStatus,
  TransactionSource,
} from '../../generated/prisma/client';
import { AddWalletAddressDto } from './dto/add-wallet-address.dto';
import type { RequestMeta } from '../auth/auth.service';
import type { SyncJobData } from './sync.processor';

const EVM_CONFIGS = {
  [WalletChain.ETHEREUM]: {
    baseUrl: 'https://api.etherscan.io/api',
    apiKeyEnvVar: 'ETHERSCAN_API_KEY',
    nativeSymbol: 'ETH',
  },
  [WalletChain.BSC]: {
    baseUrl: 'https://api.bscscan.com/api',
    apiKeyEnvVar: 'BSCSCAN_API_KEY',
    nativeSymbol: 'BNB',
  },
} as const;

@Injectable()
export class WalletAddressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aggregation: TransactionAggregationService,
    private readonly auditLog: AuditLogService,
    private readonly evmClient: EthereumLikeClient,
    private readonly btcClient: BitcoinClient,
    @InjectQueue('sync') private readonly syncQueue: Queue<SyncJobData>,
  ) {}

  async add(userId: string, dto: AddWalletAddressDto, meta: RequestMeta) {
    const wallet = await this.prisma.walletAddress.create({
      data: {
        userId,
        chain: dto.chain,
        address: dto.address,
        label: dto.label,
      },
    });
    await this.auditLog.log({
      userId,
      action: 'WALLET_ADDED',
      entity: 'WalletAddress',
      entityId: wallet.id,
      metadata: { chain: dto.chain },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    return wallet;
  }

  async listForUser(userId: string) {
    return this.prisma.walletAddress.findMany({ where: { userId } });
  }

  async remove(userId: string, id: string) {
    const wallet = await this.prisma.walletAddress.findUnique({
      where: { id },
    });
    if (!wallet || wallet.userId !== userId)
      throw new NotFoundException('Cüzdan bulunamadı');
    await this.prisma.walletAddress.delete({ where: { id } });
  }

  /** Kullanicidan gelen istek — is HEMEN kuyruga eklenir, HTTP istegi
   *  zincirin (potansiyel olarak yavas) yanitini beklemez. */
  async sync(userId: string, id: string): Promise<{ queued: true }> {
    const wallet = await this.prisma.walletAddress.findUnique({
      where: { id },
    });
    if (!wallet || wallet.userId !== userId)
      throw new NotFoundException('Cüzdan bulunamadı');

    await this.prisma.walletAddress.update({
      where: { id },
      data: { syncStatus: SyncStatus.SYNCING },
    });
    await this.syncQueue.add('wallet-sync', { kind: 'wallet', userId, id });
    return { queued: true };
  }

  /** Gercek senkronizasyon islemi — sadece SyncProcessor'dan cagrilir. */
  async performSync(userId: string, id: string): Promise<number> {
    const wallet = await this.prisma.walletAddress.findUnique({
      where: { id },
    });
    if (!wallet || wallet.userId !== userId)
      throw new NotFoundException('Cüzdan bulunamadı');

    try {
      const since = wallet.lastSyncedAt ?? undefined;
      const items =
        wallet.chain === WalletChain.BITCOIN
          ? await this.btcClient.fetchTransactions(wallet.address, since)
          : await this.evmClient.fetchTransactions(
              wallet.address,
              EVM_CONFIGS[wallet.chain],
              since,
            );

      const inserted = await this.aggregation.ingest(
        userId,
        { source: TransactionSource.WALLET, walletAddressId: wallet.id },
        items,
      );

      await this.prisma.walletAddress.update({
        where: { id },
        data: {
          syncStatus: SyncStatus.SYNCED,
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });
      return inserted;
    } catch (err) {
      await this.prisma.walletAddress.update({
        where: { id },
        data: {
          syncStatus: SyncStatus.ERROR,
          lastSyncError: (err as Error).message,
        },
      });
      throw err;
    }
  }
}
