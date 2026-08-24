import { IsEnum, IsString } from 'class-validator';
import { PaymentMethod } from '../../../generated/prisma/client';

export class CreatePaymentDto {
  @IsString()
  planId!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;
}
