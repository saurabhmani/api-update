// ════════════════════════════════════════════════════════════════
//  streamServer CLI — standalone entry for pm2/dev
//
//  Boots liveMarketFeed + WebSocket fan-out outside Next.js when
//  you want the stream decoupled from the Next lifecycle.
// ════════════════════════════════════════════════════════════════

import path from 'path';
import { config as dotenvConfig } from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
}
dotenvConfig({ path: path.resolve(process.cwd(), '.env') });

import { startLiveMarketFeed } from '../marketData/liveMarketFeed';
import { startStreamServer } from './streamServer';

startLiveMarketFeed();
const state = startStreamServer();

process.on('SIGINT',  () => { console.log('[ws-server] SIGINT — exiting');  process.exit(0); });
process.on('SIGTERM', () => { console.log('[ws-server] SIGTERM — exiting'); process.exit(0); });

console.log('[ws-server] standalone CLI booted', { port: state.port, running: state.running });
