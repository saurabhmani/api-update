// ════════════════════════════════════════════════════════════════
//  streamServer CLI — standalone entry for pm2/dev
//
//  The WebSocket price stream normally boots from Next's
//  instrumentation hook. This file exists so you can also run it
//  as its own pm2 process (`npm run ws-server`) when you want the
//  stream decoupled from the Next lifecycle.
// ════════════════════════════════════════════════════════════════

// Load .env.local in non-production only (PM2/System provides prod env)
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
}

import { startStreamServer } from './streamServer';

startStreamServer();

// Keep the process alive. startStreamServer binds a WebSocketServer
// which holds the event loop open on its own, but being explicit
// here prevents an accidental early exit if boot fails silently.
process.on('SIGINT',  () => { console.log('[ws-server] SIGINT — exiting');  process.exit(0); });
process.on('SIGTERM', () => { console.log('[ws-server] SIGTERM — exiting'); process.exit(0); });

console.log('[ws-server] standalone CLI booted');
