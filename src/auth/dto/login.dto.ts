import { IsIn, IsOptional, IsString } from 'class-validator';

export class LoginDto {
  // Kullanıcı adı, email veya telefon — hangisi oldugu `method` ile belirtilir
  // (ORCA'daki 3 yontemli giris deseni, bkz. AuthService.login).
  @IsString()
  identifier!: string;

  @IsIn(['username', 'email', 'phone'])
  method!: 'username' | 'email' | 'phone';

  @IsString()
  password!: string;

  // 2FA aciksa ikinci adimda gonderilir; kapaliysa yok sayilir.
  @IsOptional()
  @IsString()
  totpCode?: string;
}
