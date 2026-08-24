import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class IcrypexAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.ICRYPEX;
  protected readonly displayName = 'ICRYPEX';
}
