import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';
import {
  CryptoAsset,
  CryptoProvider,
  PaymentMethod,
} from '../../../generated/prisma/client';

export class CreatePaymentDto {
  @IsString()
  planId!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @ValidateIf((dto) => dto.method === 'CRYPTO')
  @IsEnum(CryptoProvider)
  cryptoProvider?: CryptoProvider;

  @ValidateIf((dto) => dto.method === 'CRYPTO')
  @IsEnum(CryptoAsset)
  cryptoAsset?: CryptoAsset;

  // Havale/EFT ve kripto icin — dekont/islem kaniti (bkz. PaymentService.uploadReceipt).
  @IsOptional()
  @IsString()
  receiptUrl?: string;

  // Bir musavirin kendi mukellefine verdigi indirim kodu — bkz.
  // CouponsService, PaymentService.createPayment.
  @IsOptional()
  @IsString()
  couponCode?: string;
}
