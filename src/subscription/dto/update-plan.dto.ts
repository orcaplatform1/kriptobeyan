import { IsBoolean, IsInt, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdatePlanDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  priceTRY?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  transactionLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  clientLimit?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
