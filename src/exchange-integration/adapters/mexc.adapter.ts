import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class MexcAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.MEXC;
  protected readonly displayName = 'MEXC';
}
