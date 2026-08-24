import { IsEmail, IsOptional } from 'class-validator';

export class ShareReportDto {
  @IsOptional()
  @IsEmail()
  email?: string;
}
