import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UserRole } from '../../../generated/prisma/client';

export class RegisterDto {
  @IsEmail()
  email!: string;

  // Giris icin ikinci kimlik — bkz. schema.prisma User.username yorumu.
  // Sadece harf/rakam/alt cizgi, boslukla karisip giris hatasi vermesin.
  @IsString()
  @MinLength(4)
  @MaxLength(16)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Kullanıcı adı sadece harf, rakam ve alt çizgi içerebilir',
  })
  username!: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  // Opsiyonel — SMS dogrulama altyapisi henuz baglanmadi (diger modullerdeki
  // API anahtari bekleyen ozelliklerle ayni durum), bu yuzden email'in
  // yerini almiyor, sadece ek bilgi olarak saklanir. Ulke kodundan SONRAKI
  // kisim tam 10 rakam olmali (ne 9 ne 11) — bkz. AuthService.register,
  // burada tek basina dogrulanamiyor cunku phoneCountryCode ile
  // karsilastirma gerekiyor.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  phoneCountryCode?: string;

  @IsString()
  @MinLength(6)
  password!: string;

  // Belirtilmezse INDIVIDUAL (bireysel) — bir muhasebeci daveti kabul
  // ederken de bu yol kullanılır ama rol her zaman INDIVIDUAL kalır (davet
  // eden zaten ACCOUNTANT'tır, müşteri değil).
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}
