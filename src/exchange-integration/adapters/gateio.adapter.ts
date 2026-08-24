import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class GateioAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.GATEIO;
  protected readonly displayName = 'Gate.io';
}
