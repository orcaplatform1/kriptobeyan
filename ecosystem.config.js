// KriptoBeyan backend — PM2 process tanımı.
// ENCRYPTION_KEY bilinçli olarak burada da elle yazılmıyor: /etc/kriptobeyan/
// secrets.env (root-only, proje/git deposu dışında) dosyasından okunup PM2'nin
// enjekte ettiği process ortamına ekleniyor. Uygulamanın kendi .env dosyası
// (bu klasörde) diğer, daha az kritik ayarları tutuyor.
const fs = require('fs');
const path = require('path');

function loadSecretsEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return env;
}

const secrets = loadSecretsEnv('/etc/kriptobeyan/secrets.env');

module.exports = {
  apps: [
    {
      name: 'kriptobeyan-backend',
      cwd: path.join(__dirname),
      script: 'npm',
      args: 'run start:prod',
      env: {
        NODE_ENV: 'production',
        ...secrets,
      },
    },
  ],
};
