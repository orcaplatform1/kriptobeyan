import { IsString, Length } from 'class-validator';

export class VerifyTwoFactorDto {
  @IsString()
  @Length(6, 6)
  code!: string;
}

export class DisableTwoFactorDto {
  @IsString()
  password!: string;

  @IsString()
  @Length(6, 6)
  code!: string;
}
