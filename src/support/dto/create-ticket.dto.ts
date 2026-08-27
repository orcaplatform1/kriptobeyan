import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

const CATEGORIES = [
  'PAYMENT',
  'TECHNICAL',
  'ACCOUNT',
  'EMAIL_PHONE_CHANGE',
  'OTHER',
] as const;

export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  subject!: string;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  body!: string;
}
