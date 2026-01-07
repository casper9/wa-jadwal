#!/usr/bin/env bash
set -euo pipefail

# =========================
# WA Scheduler - start.sh
# Debian/Ubuntu VPS Fresh
# =========================

APP_NAME="wa-scheduler"
APP_ENTRY="app.js"

# ✅ default port 300 (bisa override: APP_PORT=3000 bash start.sh)
APP_PORT="${APP_PORT:-300}"

NODE_MAJOR="${NODE_MAJOR:-20}"   # Node LTS (ubah 18 kalau mau)
TZ_REGION="Asia/Jakarta"

echo "==> [1/9] Check working directory"
if [[ ! -f "$APP_ENTRY" ]]; then
  echo "ERROR: $APP_ENTRY tidak ditemukan di folder ini."
  echo "Jalankan start.sh di folder project (ada app.js dan folder public/)."
  exit 1
fi
if [[ ! -d "public" ]]; then
  echo "WARNING: folder ./public tidak ditemukan. Pastikan index.html ada di public/."
fi

echo "==> [2/9] Set timezone to ${TZ_REGION}"
sudo apt-get update -y
sudo apt-get install -y tzdata
sudo ln -sf "/usr/share/zoneinfo/${TZ_REGION}" /etc/localtime
sudo dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1 || true

echo "==> [3/9] Install base packages"
sudo apt-get install -y curl ca-certificates gnupg git build-essential

echo "==> [4/9] Install Chromium + dependencies (for whatsapp-web.js puppeteer)"
# beberapa distro pakai libasound2t64
sudo apt-get install -y chromium \
  fonts-liberation \
  libatk-bridge2.0-0 libatk1.0-0 libcups2 libdrm2 libgbm1 libgtk-3-0 \
  libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 || true

# fallback kalau libasound2t64 tidak ada
sudo apt-get install -y libasound2t64 || sudo apt-get install -y libasound2 || true

echo "==> [5/9] Install Node.js ${NODE_MAJOR}.x + npm"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node sudah ada: $(node -v)"
fi

echo "==> [6/9] Install PM2 globally"
sudo npm i -g pm2

echo "==> [7/9] Install project dependencies"
if [[ ! -f package.json ]]; then
  echo "package.json tidak ada. Membuat minimal package.json..."
  cat > package.json <<'JSON'
{
  "name": "wa-scheduler",
  "version": "1.0.0",
  "main": "app.js",
  "type": "commonjs",
  "scripts": {
    "start": "node app.js"
  },
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

npm install
mkdir -p data

echo "==> [8/9] Configure UFW (allow port ${APP_PORT}/tcp + allow outgoing)"
# install ufw jika belum ada
sudo apt-get install -y ufw

# set default policy (incoming deny, outgoing allow)
sudo ufw default deny incoming
sudo ufw default allow outgoing

# allow SSH supaya tidak terkunci (biasanya port 22)
sudo ufw allow OpenSSH || true
sudo ufw allow 22/tcp || true

# allow app port
sudo ufw allow "${APP_PORT}/tcp"

# enable ufw (non-interactive)
sudo ufw --force enable
sudo ufw status verbose || true

echo "==> [9/9] Start with PM2 + enable auto-start on reboot"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true

# (opsional) kalau chromium sudah diinstall dari apt, puppeteer tidak perlu download
export PUPPETEER_SKIP_DOWNLOAD=1

# set PORT untuk app
export PORT="$APP_PORT"

pm2 start "$APP_ENTRY" --name "$APP_NAME" --time
pm2 save

# enable pm2 startup
STARTUP_OUT="$(pm2 startup systemd -u "$USER" --hp "$HOME" || true)"
STARTUP_CMD="$(echo "$STARTUP_OUT" | tail -n 1 | sed 's/^\s*//')"
if [[ "$STARTUP_CMD" == sudo* ]]; then
  echo "Running PM2 startup command..."
  eval "$STARTUP_CMD"
  pm2 save
else
  echo "NOTE: Kalau auto-start belum aktif, jalankan manual:"
  echo "pm2 startup systemd -u $USER --hp $HOME"
  echo "pm2 save"
fi

echo ""
echo "✅ DONE!"
echo "App Name : $APP_NAME"
echo "Port     : $APP_PORT"
echo "UFW      : allow ${APP_PORT}/tcp, outgoing allow"
echo ""
echo "Cek:"
echo "- pm2 status"
echo "- pm2 logs $APP_NAME"
echo "- buka: http://IP-VPS:${APP_PORT}/"
