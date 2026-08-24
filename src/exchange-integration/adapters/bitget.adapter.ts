import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class BitgetAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.BITGET;
  protected readonly displayName = 'Bitget';
}
