import { Injectable } from '@nestjs/common';
import { TransactionType } from '../../../generated/prisma/client';
import type { NormalizedExchangeTransaction } from '../adapters/exchange-adapter.interface';

// Blockstream.info herkese acik, API key gerektirmiyor.
const BASE_URL = 'https://blockstream.info/api';

interface BlockstreamVout {
  scriptpubkey_address?: string;
  value: number;
}

interface BlockstreamVin {
  prevout?: BlockstreamVout;
}

interface BlockstreamTx {
  txid: string;
  fee?: number;
  status?: { block_time?: number };
  vout: BlockstreamVout[];
  vin: BlockstreamVin[];
}

@Injectable()
export class BitcoinClient {
  async fetchTransactions(
    address: string,
    since?: Date,
  ): Promise<NormalizedExchangeTransaction[]> {
    const res = await fetch(`${BASE_URL}/address/${address}/txs`);
    if (!res.ok) throw new Error(`Blockstream API hatası: ${res.status}`);
    const txs = (await res.json()) as BlockstreamTx[];

    const results: NormalizedExchangeTransaction[] = [];
    for (const tx of txs) {
      const timestamp = tx.status?.block_time
        ? new Date(tx.status.block_time * 1000)
        : new Date();
      if (since && timestamp < since) continue;

      const receivedSats = tx.vout
        .filter((o) => o.scriptpubkey_address === address)
        .reduce((sum, o) => sum + o.value, 0);
      const sentSats = tx.vin
        .filter((i) => i.prevout?.scriptpubkey_address === address)
        .reduce((sum, i) => sum + (i.prevout?.value ?? 0), 0);

      const net = receivedSats - sentSats;
      if (net === 0) continue;

      results.push({
        externalId: `btc-${tx.txid}`,
        type:
          net > 0 ? TransactionType.TRANSFER_IN : TransactionType.TRANSFER_OUT,
        asset: 'BTC',
        quantity: (Math.abs(net) / 1e8).toString(),
        feeAmount: net < 0 && tx.fee ? (tx.fee / 1e8).toString() : undefined,
        feeAsset: net < 0 ? 'BTC' : undefined,
        timestamp,
        raw: tx,
      });
    }
    return results;
  }
}
