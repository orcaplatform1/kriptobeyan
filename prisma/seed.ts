import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL tanımlı değil');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Fiyat/limitler burada sabit KODLANMIŞ görünüyor ama bu sadece BAŞLANGIÇ
// verisi — canlıda admin, /admin/plans üzerinden değiştirir (bkz.
// AdminPlansController). Kod hiçbir yerde bu sayıları hardcode kullanmaz,
// hep bu tablodan okunur.
const PLANS = [
  { name: 'FREE', type: 'INDIVIDUAL', priceTRY: 0, transactionLimit: 0, clientLimit: null },
  { name: 'STARTER', type: 'INDIVIDUAL', priceTRY: 299, transactionLimit: 100, clientLimit: null },
  { name: 'STANDARD', type: 'INDIVIDUAL', priceTRY: 599, transactionLimit: 500, clientLimit: null },
  { name: 'PRO', type: 'INDIVIDUAL', priceTRY: 999, transactionLimit: 2000, clientLimit: null },
  { name: 'TRADER', type: 'INDIVIDUAL', priceTRY: 1499, transactionLimit: 10000, clientLimit: null },
  { name: 'ACCOUNTANT_10', type: 'ACCOUNTANT', priceTRY: 2499, transactionLimit: null, clientLimit: 10 },
  { name: 'ACCOUNTANT_20', type: 'ACCOUNTANT', priceTRY: 4499, transactionLimit: null, clientLimit: 20 },
  { name: 'ACCOUNTANT_50', type: 'ACCOUNTANT', priceTRY: 9999, transactionLimit: null, clientLimit: 50 },
  { name: 'ACCOUNTANT_100', type: 'ACCOUNTANT', priceTRY: 17999, transactionLimit: null, clientLimit: 100 },
] as const;

async function main() {
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { name: plan.name },
      update: {
        priceTRY: plan.priceTRY,
        transactionLimit: plan.transactionLimit,
        clientLimit: plan.clientLimit,
      },
      create: plan,
    });
  }
  console.log(`${PLANS.length} plan seed edildi/güncellendi`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
