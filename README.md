# KriptoBeyan — Backend

NestJS + PostgreSQL (Prisma) tabanlı backend. ORCA (traders.tr) projesinden
tamamen bağımsız — ayrı veritabanı, ayrı port (3003), ayrı PM2 process, ayrı
depo.

## Güvenlik mimarisi

- **Auth**: JWT access token (15dk) + rotasyonlu refresh token (30gün, sadece
  hash'i saklanır, tekrar kullanım tespitinde tüm oturumlar iptal edilir).
- **2FA**: TOTP tabanlı (otplib), secret AES-256-GCM ile şifreli saklanır.
- **Brute-force koruması**: login/register endpoint'lerinde sıkı rate limit
  (`@nestjs/throttler`) + 5 başarısız denemeden sonra 15dk hesap kilidi.
- **Borsa API key'leri**: AES-256-GCM ile at-rest şifreli, liste/detay
  uçları sadece maskelenmiş halini döner. Kayıt sırasında kullanıcının
  read-only key kullandığını onaylaması zorunlu.
- **Encryption key**: uygulamanın `.env` dosyasında DEĞİL —
  `/etc/kriptobeyan/secrets.env` (root-only, bu depo dışında) dosyasından
  PM2 (`ecosystem.config.js`) tarafından process ortamına enjekte edilir.
- **Audit/Security log**: `AuditLog` (normal işlemler) ve `SecurityLog`
  (başarısız giriş, kilit, şüpheli aktivite) ayrı tutulur.
- **Helmet, CORS (sadece kriptobeyan.com), DTO validation** (class-validator,
  `whitelist`+`forbidNonWhitelisted`).

## Geliştirme

```bash
npm install
npx prisma generate
npx prisma db push   # şema değişikliklerini DB'ye uygula
npm run start:dev
```

`.env` içindeki `DATABASE_URL` ve JWT secret'ları gerekir; `ENCRYPTION_KEY`
ayrıca process ortamında (bkz. yukarı) olmalı — lokal geliştirmede geçici
olarak `export ENCRYPTION_KEY=...` ile de sağlanabilir.
