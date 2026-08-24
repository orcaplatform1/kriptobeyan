import { Injectable, Logger } from '@nestjs/common';
import { TransactionType } from '../../../generated/prisma/client';
import type { NormalizedExchangeTransaction } from '../adapters/exchange-adapter.interface';

// Etherscan/BscScan ayni "Etherscan Multichain API" formatini kullanir.
// API key lansmana kadar bos birakilabilir (bkz. proje notu) — bu durumda
// senkronizasyon atlanir, hata firlatilmaz.
export interface EvmClientConfig {
  baseUrl: string;
  apiKeyEnvVar: string;
  nativeSymbol: string;
}

interface EtherscanNativeTx {
  hash: string;
  to: string;
  value: string;
  timeStamp: string;
  gasUsed: string;
  gasPrice: string;
}

interface EtherscanTokenTx {
  hash: string;
  to: string;
  value: string;
  timeStamp: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

@Injectable()
export class EthereumLikeClient {
  private readonly logger = new Logger(EthereumLikeClient.name);

  async fetchTransactions(
    address: string,
    config: EvmClientConfig,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const apiKey = process.env[config.apiKeyEnvVar];
    if (!apiKey) {
      this.logger.warn(
        `${config.apiKeyEnvVar} tanımlı değil — ${config.nativeSymbol} cüzdan senkronizasyonu atlandı`,
      );
      return [];
    }

    const results: NormalizedExchangeTransaction[] = [];
    results.push(
      ...(await this.fetchNativeTransfers(address, config, apiKey, since)),
    );
    results.push(
      ...(await this.fetchTokenTransfers(address, config, apiKey, since)),
    );
    return results;
  }

  private async fetchNativeTransfers(
    address: string,
    config: EvmClientConfig,
    apiKey: string,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const url = `${config.baseUrl}?module=account&action=txlist&address=${address}&sort=desc&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(`${config.nativeSymbol} txlist hatası: ${res.status}`);
    const json = (await res.json()) as { result: EtherscanNativeTx[] | string };
    if (!Array.isArray(json.result)) return [];

    return json.result
      .filter((tx) => Number(tx.value) > 0)
      .filter((tx) => !since || Number(tx.timeStamp) * 1000 >= since.getTime())
      .map((tx): NormalizedExchangeTransaction => {
        const isIncoming = tx.to?.toLowerCase() === address.toLowerCase();
        return {
          externalId: `native-${tx.hash}`,
          type: isIncoming
            ? TransactionType.TRANSFER_IN
            : TransactionType.TRANSFER_OUT,
          asset: config.nativeSymbol,
          quantity: (Number(tx.value) / 1e18).toString(),
          feeAmount: !isIncoming
            ? ((Number(tx.gasUsed) * Number(tx.gasPrice)) / 1e18).toString()
            : undefined,
          feeAsset: !isIncoming ? config.nativeSymbol : undefined,
          timestamp: new Date(Number(tx.timeStamp) * 1000),
          raw: tx,
        };
      });
  }

  private async fetchTokenTransfers(
    address: string,
    config: EvmClientConfig,
    apiKey: string,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const url = `${config.baseUrl}?module=account&action=tokentx&address=${address}&sort=desc&apikey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(`${config.nativeSymbol} tokentx hatası: ${res.status}`);
    const json = (await res.json()) as { result: EtherscanTokenTx[] | string };
    if (!Array.isArray(json.result)) return [];

    return json.result
      .filter((tx) => !since || Number(tx.timeStamp) * 1000 >= since.getTime())
      .map((tx): NormalizedExchangeTransaction => {
        const isIncoming = tx.to?.toLowerCase() === address.toLowerCase();
        const decimals = Number(tx.tokenDecimal ?? 18);
        return {
          externalId: `token-${tx.hash}-${tx.tokenSymbol}`,
          type: isIncoming
            ? TransactionType.TRANSFER_IN
            : TransactionType.TRANSFER_OUT,
          asset: tx.tokenSymbol,
          quantity: (Number(tx.value) / Math.pow(10, decimals)).toString(),
          timestamp: new Date(Number(tx.timeStamp) * 1000),
          raw: tx,
        };
      });
  }
}
