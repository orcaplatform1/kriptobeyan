import { Injectable } from '@nestjs/common';
import { ExchangeProvider } from '../../../generated/prisma/client';
import { StubExchangeAdapter } from './stub-adapter.base';

@Injectable()
export class BitexenAdapter extends StubExchangeAdapter {
  readonly provider = ExchangeProvider.BITEXEN;
  protected readonly displayName = 'Bitexen';
}
