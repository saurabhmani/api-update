/**
 * PM2 Ecosystem — Quantorus365 (Private VPS)
 *
 * One PM2 entry. server.js is the unified Node process — it owns:
 *   • Next.js HTTP server             → port 5000
 *   • WebSocket stream server         → port 5001
 *   • quantorus365-scheduler          (long-running child)
 *   • q365-manipulation-scan          (cron: 0 13 * * * UTC)
 *   • q365-learning-scheduler         (cron: 0 15 * * * UTC)
 *
 * Child workers are spawned + supervised from server.js, so PM2
 * only sees the one parent. If the parent dies, PM2 restarts it
 * and the children come back with it atomically.
 *
 * BEFORE FIRST RUN:
 *   1. Set APP_DIR below (or export APP_DIR before `pm2 start`).
 *   2. mkdir -p ${APP_DIR}/logs
 *   3. npm install && npm run build
 *   4. pm2 start ecosystem.config.js --env production
 *   5. pm2 save && pm2 startup   (run the printed command as root)
 *
 * Ports (never expose — nginx proxies internally):
 *   5000 → Next.js   (nginx: location /)
 *   5001 → WS stream (nginx: location /ws)
 */

const APP_DIR = process.env.APP_DIR || '/var/www/api-update';

const SHARED_ENV = {
  NODE_ENV: 'production',
  DOTENV_CONFIG_PATH: `${APP_DIR}/.env.local`,
  PORT: 5000,
  STREAM_WS_PORT: 5001,
};

module.exports = {
  apps: [
    {
      name: 'quantorus365-app',
      script: 'server.js',
      cwd: APP_DIR,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      restart_delay: 3000,
      max_restarts: 20,
      kill_timeout: 12000, // give server.js time to SIGTERM its children
      env:            { ...SHARED_ENV },
      env_production: { ...SHARED_ENV },
      error_file: `${APP_DIR}/logs/app-error.log`,
      out_file:   `${APP_DIR}/logs/app-out.log`,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
