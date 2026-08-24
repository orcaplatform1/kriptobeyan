import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class BitciAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.BITCI;
  protected readonly displayName = 'Bitci';
}
