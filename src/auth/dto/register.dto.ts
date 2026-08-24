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
  @MinLength(3)
  @MaxLength(24)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Kullanıcı adı sadece harf, rakam ve alt çizgi içerebilir',
  })
  username!: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  // Opsiyonel — SMS dogrulama altyapisi henuz baglanmadi (diger modullerdeki
  // API anahtari bekleyen ozelliklerle ayni durum), bu yuzden email'in
  // yerini almiyor, sadece ek bilgi olarak saklanir.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(6)
  phoneCountryCode?: string;

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
