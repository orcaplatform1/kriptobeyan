import { IsEmail, IsString } from 'class-validator';

export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}

export class VerifyEmailDto {
  @IsString()
  token!: string;
}
