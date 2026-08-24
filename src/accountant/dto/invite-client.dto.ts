import { IsEmail } from 'class-validator';

export class InviteClientDto {
  @IsEmail()
  email!: string;
}
