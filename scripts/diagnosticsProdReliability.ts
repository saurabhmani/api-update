#!/usr/bin/env tsx
/**
 * Production reliability probe — run ON THE VPS (uses production .env / MYSQL_*).
 *
 *   npx tsx scripts/diagnosticsProdReliability.ts
 *   BASE_URL=http://127.0.0.1:5000 npx tsx scripts/diagnosticsProdReliability.ts
 *   BASE_URL=https://quantorus.in npx tsx scripts/diagnosticsProdReliability.ts
 *
 * Does not print secrets. Compares DB APPROVED snapshot counts vs API JSON.
 */
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

function loadEnv() {
  const cwd = process.cwd();
  const candidates =
    process.env.NODE_ENV === 'production'
      ? [resolve(cwd, '.env'), resolve(cwd, '.env.production')]
      : [resolve(cwd, '.env.local'), resolve(cwd, '.env')];
  for (const p of candidates) {
    if (existsSync(p)) {
      config({ path: p });
      console.log(`[env] loaded ${p}`);
      return;
    }
  }
  config();
}

loadEnv();

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');

async function timedFetch(path: string, timeoutMs = 25_000) {
  const url = `${BASE}${path}`;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    return {
      path,
      status: res.status,
      ms,
      bytes: Buffer.byteLength(text),
      degraded: res.headers.get('x-notifications-degraded')
        ?? res.headers.get('X-Notifications-Degraded'),
      serverTiming: res.headers.get('server-timing'),
      json,
      error: null as string | null,
    };
  } catch (err) {
    return {
      path,
      status: 0,
      ms: Date.now() - t0,
      bytes: 0,
      degraded: null,
      serverTiming: null,
      json: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function dbApproved() {
  try {
    const { db } = await import('../src/lib/db');
    const { rows } = await db.query<{
      active: number;
      buy: number;
      sell: number;
    }>(
      `SELECT
         SUM(CASE WHEN status = 'ACTIVE' AND valid_until > NOW() THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'ACTIVE' AND valid_until > NOW()
                   AND UPPER(direction) = 'BUY' THEN 1 ELSE 0 END) AS buy,
         SUM(CASE WHEN status = 'ACTIVE' AND valid_until > NOW()
                   AND UPPER(direction) = 'SELL' THEN 1 ELSE 0 END) AS sell
       FROM q365_confirmed_signal_snapshots`,
    );
    const r = rows?.[0];
    return {
      ok: true,
      active: Number(r?.active ?? 0),
      buy: Number(r?.buy ?? 0),
      sell: Number(r?.sell ?? 0),
      host: process.env.MYSQL_HOST ?? 'unset',
      database: process.env.MYSQL_DATABASE ?? 'unset',
    };
  } catch (err) {
    return {
      ok: false,
      active: null as number | null,
      buy: null as number | null,
      sell: null as number | null,
      host: process.env.MYSQL_HOST ?? 'unset',
      database: process.env.MYSQL_DATABASE ?? 'unset',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  console.log('=== Production reliability probe ===');
  console.log({
    BASE,
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT || process.env.NEXT_PORT || '5000',
    MYSQL_HOST: process.env.MYSQL_HOST ?? 'unset',
    MYSQL_DATABASE: process.env.MYSQL_DATABASE ?? 'unset',
    API_FRESHNESS_FALLBACK_ENABLED: process.env.API_FRESHNESS_FALLBACK_ENABLED ?? '(default true)',
    NOTIFICATIONS_FEED_BUDGET_MS: process.env.NOTIFICATIONS_FEED_BUDGET_MS ?? '(default 8000)',
    NOTIFICATIONS_SUMMARY_BUDGET_MS: process.env.NOTIFICATIONS_SUMMARY_BUDGET_MS ?? '(default 3000)',
  });

  const db = await dbApproved();
  console.log('\n[DB] ACTIVE confirmed snapshots (APPROVED definition):', db);

  const paths = [
    '/api/health',
    '/api/notifications?summary=1',
    '/api/notifications',
    '/api/signals?action=all&limit=20&request_id=diag-reliability',
    '/api/dashboard',
  ];

  console.log('\n[HTTP] probing', BASE);
  for (const p of paths) {
    const r = await timedFetch(p);
    const summary: Record<string, unknown> = {
      path: r.path,
      status: r.status,
      ms: r.ms,
      bytes: r.bytes,
      error: r.error,
      degraded: r.degraded,
    };
    if (p.includes('notifications')) {
      summary.unreadCount = r.json?.unreadCount;
      summary.timings = r.json?.timings;
      summary.degradedBody = r.json?.degraded;
    }
    if (p.includes('/api/signals')) {
      summary.code = r.json?.code;
      summary.approvedCount = r.json?.approvedCount ?? r.json?.counters?.approvedTotal;
      summary.reportStatus = r.json?.dailyReportPreview?.reportStatus;
      summary.insufficientReason = r.json?.dailyReportPreview?.insufficientReason;
      summary.signalsLen = Array.isArray(r.json?.signals) ? r.json.signals.length : null;
    }
    if (p.includes('/api/dashboard')) {
      summary.approvedTotal = r.json?.signalSummary?.approvedTotal;
      summary.approvedSource = r.json?.signalSummary?.approvedSource;
      summary.countsAvailable = r.json?.signalSummary?.countsAvailable;
      summary.signalsTimedOut = r.json?.signalSummary?.signalsTimedOut;
    }
    console.log(JSON.stringify(summary));
  }

  console.log('\n[COMPARE] DB.active vs dashboard/API APPROVED');
  console.log({
    db_active: db.active,
    note: 'Dashboard approvedTotal must equal db_active when approvedSource=confirmed_snapshots',
    insufficient_data_means:
      'required approvedSuccess OR highPotentialPerformed outcome counters; both null → INSUFFICIENT_DATA (semantic, not timeout)',
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
