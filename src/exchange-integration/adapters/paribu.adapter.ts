import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class ParibuAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.PARIBU;
  protected readonly displayName = 'Paribu';
}
