import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  CostBasisMethod,
  TaxpayerType,
} from '../../../generated/prisma/client';

export class UpdateTaxSettingsDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  baseCurrency?: string;

  @IsOptional()
  @IsEnum(CostBasisMethod)
  costBasisMethod?: CostBasisMethod;

  @IsOptional()
  @IsEnum(TaxpayerType)
  taxpayerType?: TaxpayerType;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  timezone?: string;
}
