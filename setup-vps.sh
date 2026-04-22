#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  Quantorus365 — Private VPS Setup Script
#
#  Run this ONCE after uploading the code to your VPS.
#  Must be run from the deploy directory as the app user (not root).
#
#  Usage:
#    chmod +x setup-vps.sh
#    ./setup-vps.sh
#
#  What it does:
#    1. Detects the deploy path and writes it to ecosystem.config.js
#    2. Creates the logs/ directory
#    3. Installs npm dependencies (including dotenv)
#    4. Builds Next.js for production
#    5. Creates .env.local from .env.example if it doesn't exist yet
#    6. Runs all database migrations
#    7. Starts all PM2 processes
#    8. Prints the nginx config block you need to add
# ═══════════════════════════════════════════════════════════════════

set -e  # Exit on any error

# ── Colors ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "  $1"; }

APP_DIR="$(pwd)"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Quantorus365 — VPS Setup"
echo "  Deploy path: $APP_DIR"
echo "════════════════════════════════════════════════════════════════"
echo ""

# ── 1. Patch APP_DIR into ecosystem.config.js ────────────────────────
if grep -q "'/var/www/quantorus365'" ecosystem.config.js; then
  sed -i "s|'/var/www/quantorus365'|'${APP_DIR}'|g" ecosystem.config.js
  ok "APP_DIR set to $APP_DIR in ecosystem.config.js"
else
  ok "APP_DIR already customised in ecosystem.config.js"
fi

# ── 2. Create logs directory ─────────────────────────────────────────
mkdir -p "$APP_DIR/logs"
ok "logs/ directory ready"

# ── 3. Create .env.local if missing ──────────────────────────────────
if [ ! -f "$APP_DIR/.env.local" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env.local"
  warn ".env.local created from .env.example — EDIT IT NOW before continuing"
  warn "Required: MYSQL_*, SESSION_SECRET, ENCRYPTION_KEY, KITE_API_KEY, KITE_API_SECRET, NEXT_PUBLIC_APP_URL"
  echo ""
  read -p "  Press ENTER after you have edited .env.local to continue..." _
else
  ok ".env.local already exists"
fi

# ── 4. Install dependencies ───────────────────────────────────────────
echo ""
echo "Installing npm dependencies..."
npm install
ok "npm install complete"

# ── 5. Build Next.js ─────────────────────────────────────────────────
echo ""
echo "Building Next.js for production..."
npm run build
ok "Build complete"

# ── 6. Run all database migrations ───────────────────────────────────
echo ""
echo "Running database migrations..."
npm run db:migrate-all
ok "Migrations complete"

# ── 7. Start PM2 processes ────────────────────────────────────────────
echo ""
echo "Starting PM2 processes..."
pm2 start ecosystem.config.js --env production
pm2 save
ok "PM2 processes started and saved"

echo ""
pm2 status

# ── 8. Set up PM2 auto-start on reboot ───────────────────────────────
echo ""
echo "Setting up PM2 auto-start on reboot..."
pm2 startup systemd -u $USER --hp $HOME | grep "sudo" | bash || \
  warn "Could not auto-run startup command. Run 'pm2 startup' manually and execute the printed command as root."

# ── 9. Print nginx config ─────────────────────────────────────────────
DOMAIN=$(grep NEXT_PUBLIC_APP_URL "$APP_DIR/.env.local" 2>/dev/null | sed 's/.*=https\?:\/\///' | tr -d ' ')
DOMAIN="${DOMAIN:-yourdomain.com}"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  NEXT STEP: Add this nginx config"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "  sudo nano /etc/nginx/sites-available/quantorus365"
echo ""
cat << NGINX
# Paste this into /etc/nginx/sites-available/quantorus365

server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN} www.${DOMAIN};

    # SSL (Certbot fills these in automatically)
    # Run: sudo certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}
    # ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # WebSocket proxy — REQUIRED for live prices
    # Proxies wss://${DOMAIN}/ws → ws://localhost:3001
    location /ws {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
        proxy_set_header   X-Real-IP  \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }

    # Next.js app
    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        proxy_buffering    off;
    }

    location /_next/static {
        proxy_pass http://127.0.0.1:3000;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
NGINX

echo ""
echo "  After adding the nginx config:"
echo "    sudo ln -s /etc/nginx/sites-available/quantorus365 /etc/nginx/sites-enabled/"
echo "    sudo nginx -t"
echo "    sudo certbot --nginx -d ${DOMAIN}"
echo "    sudo systemctl reload nginx"
echo ""
echo "  Open firewall ports:"
echo "    sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow OpenSSH && sudo ufw enable"
echo ""
echo "════════════════════════════════════════════════════════════════"
ok "Setup complete. Visit https://${DOMAIN} once nginx is configured."
echo "════════════════════════════════════════════════════════════════"
echo ""
