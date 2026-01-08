#!/usr/bin/env bash
set -Eeuo pipefail

# =========================
# WA Scheduler - start.sh
# Auto download app.js + public/index.html
# =========================

APP_NAME="wa-scheduler"
APP_ENTRY="app.js"
APP_PORT="${APP_PORT:-300}"
NODE_MAJOR="${NODE_MAJOR:-20}"
TZ_REGION="Asia/Jakarta"

APP_JS_URL="https://raw.githubusercontent.com/casper9/wa-jadwal/main/app.js"
INDEX_HTML_URL="https://raw.githubusercontent.com/casper9/wa-jadwal/main/public/index.html"

trap 'echo ""; echo "❌ ERROR di baris $LINENO"; echo "Command: $BASH_COMMAND"; exit 1' ERR

echo "==> [1/10] Prepare project files"

# ambil app.js (overwrite biar selalu update)
echo "Download app.js dari GitHub..."
curl -fsSL "$APP_JS_URL" -o app.js

# buat folder public jika belum ada
mkdir -p public

# ambil index.html (overwrite)
echo "Download public/index.html dari GitHub..."
curl -fsSL "$INDEX_HTML_URL" -o public/index.html

echo "✅ app.js & public/index.html siap"

echo "==> [2/10] Set timezone ${TZ_REGION}"
sudo apt-get update -y
sudo apt-get install -y tzdata
sudo ln -sf "/usr/share/zoneinfo/${TZ_REGION}" /etc/localtime
sudo dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1 || true

echo "==> [3/10] Install base packages"
sudo apt-get install -y curl ca-certificates gnupg git build-essential

echo "==> [4/10] Install Chromium (Puppeteer)"
sudo apt-get install -y chromium \
  fonts-liberation \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 || true

sudo apt-get install -y libasound2t64 || sudo apt-get install -y libasound2 || true

echo "==> [5/10] Install Node.js ${NODE_MAJOR}.x"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> [6/10] Install PM2"
sudo npm install -g pm2

echo "==> [7/10] Install npm dependencies"
if [[ ! -f package.json ]]; then
  cat > package.json <<'JSON'
{
  "name": "wa-scheduler",
  "version": "1.0.0",
  "main": "app.js",
  "type": "commonjs",
  "scripts": { "start": "node app.js" },
  "dependencies": {
    "express": "^4.19.2",
    "node-schedule": "^2.1.1",
    "qrcode": "^1.5.3",
    "whatsapp-web.js": "^1.26.0",
    "puppeteer": "^23.0.0"
  }
}
JSON
fi

export PUPPETEER_SKIP_DOWNLOAD=1
npm install
mkdir -p data

echo "==> [8/10] Configure UFW"
sudo apt-get install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH || true
sudo ufw allow 22/tcp || true
sudo ufw allow "${APP_PORT}/tcp"
sudo ufw --force enable

echo "==> [9/10] Start app with PM2"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
export PORT="$APP_PORT"
pm2 start app.js --name "$APP_NAME" --time
pm2 save

echo "==> [10/10] Enable PM2 auto-start"
pm2 startup systemd -u "$USER" --hp "$HOME" | grep sudo | bash || true
pm2 save

echo ""
echo "✅ SELESAI"
echo "App  : $APP_NAME"
echo "Port : $APP_PORT"
echo "URL  : http://IP-VPS:$APP_PORT"
echo "Logs : pm2 logs $APP_NAME"