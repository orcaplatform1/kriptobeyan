import { Equals, IsString, MinLength } from 'class-validator';

export class CreateExchangeApiKeyDto {
  @IsString()
  exchange!: string;

  @IsString()
  label!: string;

  @IsString()
  @MinLength(8)
  apiKey!: string;

  @IsString()
  @MinLength(8)
  apiSecret!: string;

  // Kullanici bilerek/isteyerek onaylamadan (true göndermeden) kayit
  // OLUŞTURULAMAZ — borsada withdraw izni OLMAYAN, sadece read-only bir key
  // kullandigini teyit ediyor. Frontend bunu acik bir uyari/checkbox ile
  // sunmali ("Bu key'e borsada kesinlikle para cekme izni vermeyin").
  @Equals(true, { message: 'Read-only key kullandığınızı onaylamanız gerekiyor' })
  confirmedReadOnly!: boolean;
}
