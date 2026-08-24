import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class CryptocomAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.CRYPTOCOM;
  protected readonly displayName = 'Crypto.com';
}
