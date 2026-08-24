import { Module } from '@nestjs/common';
import { SpamFilterService } from './spam-filter.service';

@Module({
  providers: [SpamFilterService],
  exports: [SpamFilterService],
})
export class SpamFilterModule {}
