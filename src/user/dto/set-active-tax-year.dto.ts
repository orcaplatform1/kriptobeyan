import { IsInt, Max, Min } from 'class-validator';

export class SetActiveTaxYearDto {
  @IsInt()
  @Min(2009) // Bitcoin whitepaper öncesi bir yıl kabul etmenin anlamı yok
  @Max(2100)
  taxYear!: number;
}
