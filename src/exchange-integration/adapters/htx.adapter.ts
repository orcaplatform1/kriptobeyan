import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class HtxAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.HTX;
  protected readonly displayName = 'HTX (Huobi)';
}
