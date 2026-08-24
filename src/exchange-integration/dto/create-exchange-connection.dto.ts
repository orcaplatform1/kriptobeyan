import {
  Equals,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { ExchangeProvider } from '../../../generated/prisma/client';

export class CreateExchangeConnectionDto {
  @IsEnum(ExchangeProvider)
  provider!: ExchangeProvider;

  @IsString()
  label!: string;

  @IsString()
  @MinLength(8)
  apiKey!: string;

  @IsString()
  @MinLength(8)
  apiSecret!: string;

  @IsOptional()
  @IsString()
  passphrase?: string; // OKX icin gerekli

  // Kullanici bilerek/isteyerek onaylamadan (true göndermeden) kayıt
  // OLUŞTURULAMAZ — borsada withdraw izni OLMAYAN, sadece read-only bir key
  // kullandığını teyit ediyor.
  @Equals(true, {
    message: 'Read-only key kullandığınızı onaylamanız gerekiyor',
  })
  confirmedReadOnly!: boolean;
}
