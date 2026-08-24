/**
 * Ilk admin'i eklemek icin — admin paneli olmadan "kim ilk admin'i ekleyecek"
 * probleminin cozumu. Komut satirindan calistirilir, DB'ye dogrudan yazar.
 *
 * Kullanim:
 *   npx ts-node scripts/promote-staff.ts kullanici@example.com
 *
 * Kullanicinin ONCEDEN normal /auth/register ile kayit olmus olmasi gerekir
 * (Staff, bir User'a bagli bir "ekstra yetki" kaydidir, ayri bir login
 * sistemi degildir — ayni email/parola/2FA ile giris yapmaya devam eder).
 */
import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL tanımlı değil');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Kullanım: npx ts-node scripts/promote-staff.ts <email>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(
      `Kullanıcı bulunamadı: ${email} — önce /auth/register ile kayıt olmalı`,
    );
    process.exit(1);
  }

  const staff = await prisma.staff.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, role: 'ADMIN' },
  });

  console.log(`${email} artık admin/staff (id: ${staff.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
