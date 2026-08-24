import { IsEmail, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  // 2FA aciksa ikinci adimda gonderilir; kapaliysa yok sayilir.
  @IsOptional()
  @IsString()
  totpCode?: string;
}
