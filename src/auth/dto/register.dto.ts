import { IsEmail, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  // Gercek uygulamada @Matches ile buyuk/kucuk harf+rakam+sembol zorunlu
  // tutulabilir; simdilik minimum uzunluk (argon2 zaten zayif parolalari
  // brute-force'a karsi bir olcude yavaslatir, ama uzunluk ilk savunma).
  @IsString()
  @MinLength(10)
  password!: string;
}
