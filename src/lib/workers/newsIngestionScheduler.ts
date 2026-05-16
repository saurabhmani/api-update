// ════════════════════════════════════════════════════════════════
//  News Ingestion Scheduler — Quantorus365
//
//  Runs periodic news ingestion via node-cron.
//
//  Schedule:
//    - Every 30 minutes during market hours (09:00–16:00 IST)
//    - Every 2 hours outside market hours
//
//  Triggering:
//    - Manual: node -r ts-node/register src/lib/workers/newsIngestionScheduler.ts
//    - PM2:   add to ecosystem.config.js
// ════════════════════════════════════════════════════════════════

// ── Bootstrap: load .env.local + path aliases ────────────────────
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as path from 'path';

try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch { /* .env.local might not exist in CI */ }

import * as cron from 'node-cron';
import { runNewsPipeline } from '@/lib/news-engine/pipeline/runNewsPipeline';

let running = false;

// Operator switch — set NEWS_PIPELINE_ENABLED=false to silence the
// scheduler without removing it from PM2 / process tree. Default true.
const PIPELINE_ENABLED = process.env.NEWS_PIPELINE_ENABLED !== 'false';

async function tick() {
  if (!PIPELINE_ENABLED) {
    console.log('[newsScheduler] disabled via NEWS_PIPELINE_ENABLED=false');
    return;
  }
  if (running) {
    console.log('[newsScheduler] previous run still active, skipping');
    return;
  }

  running = true;
  const label = new Date().toISOString();
  console.log(`[newsScheduler] starting ingestion at ${label}`);

  try {
    const result = await runNewsPipeline('Indian stock market NSE', 15);
    console.log(
      `[newsScheduler] done: fetched=${result.totalFetched} new=${result.newEvents} ` +
      `dupes=${result.duplicatesSkipped} errors=${result.errors.length}`,
    );
  } catch (err) {
    console.error('[newsScheduler] pipeline failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

// ── Cron jobs ────────────────────────────────────────────────────
// Market hours: every 30 min, 9:00-16:00 IST (Mon-Fri)
cron.schedule('*/30 9-15 * * *', tick, { timezone: 'Asia/Kolkata' });
// 16:00 final run
cron.schedule('0 16 * * *', tick, { timezone: 'Asia/Kolkata' });
// Off-hours: every 2 hours
cron.schedule('0 */2 * * 0,6', tick, { timezone: 'Asia/Kolkata' });
cron.schedule('0 0,2,4,6,8,17,19,21,23 * * *', tick, { timezone: 'Asia/Kolkata' });

console.log('[newsScheduler] started. Market-hours: every 30m, off-hours: every 2h');

// Run once immediately on start
tick();

// CLI entry point
if (require.main === module) {
  // Keep alive — cron handles scheduling
}
