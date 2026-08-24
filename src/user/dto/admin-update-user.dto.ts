import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { UserRole } from '../../../generated/prisma/client';

export class AdminUpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  emailVerified?: boolean;

  // true gonderilirse hesap kilidi (lockedUntil + failedLoginCount) temizlenir.
  @IsOptional()
  @IsBoolean()
  unlock?: boolean;
}
