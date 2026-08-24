import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../../generated/prisma/client';

export class RegisterDto {
  @IsEmail()
  email!: string;

  // Gercek uygulamada @Matches ile buyuk/kucuk harf+rakam+sembol zorunlu
  // tutulabilir; simdilik minimum uzunluk (argon2 zaten zayif parolalari
  // brute-force'a karsi bir olcude yavaslatir, ama uzunluk ilk savunma).
  @IsString()
  @MinLength(10)
  password!: string;

  // Belirtilmezse INDIVIDUAL (bireysel) — bir muhasebeci daveti kabul
  // ederken de bu yol kullanılır ama rol her zaman INDIVIDUAL kalır (davet
  // eden zaten ACCOUNTANT'tır, müşteri değil).
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
