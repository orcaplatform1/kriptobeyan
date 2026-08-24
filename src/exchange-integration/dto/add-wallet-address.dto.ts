import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { WalletChain } from '../../../generated/prisma/client';

export class AddWalletAddressDto {
  @IsEnum(WalletChain)
  chain!: WalletChain;

  @IsString()
  @MinLength(10)
  @MaxLength(120)
  address!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}
