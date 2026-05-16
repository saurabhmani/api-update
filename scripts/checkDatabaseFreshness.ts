/**
 * scripts/checkDatabaseFreshness.ts
 *
 * Answers ONE question: is the database actively being updated, or
 * are the writers dead?
 *
 * Checks every layer that should be writing during normal operation:
 *   1. q365_signals               — scanner / regen output
 *   2. q365_confirmed_signal_snapshots  — promotion writer
 *   3. q365_signal_maturity_tracker     — maturity worker
 *   4. market_data_daily          — candle ingest (Yahoo)
 *
 * For each layer it reports:
 *   - latest_at           timestamp of newest row
 *   - age_minutes         how stale the freshest row is now
 *   - rows_last_5min      count of rows written in the last 5 min
 *   - rows_last_60min     count of rows written in the last hour
 *   - status              ✓ fresh / ⚠ slow / ✗ stale (per-layer thresholds)
 *
 * Final verdict — one of:
 *   ✓ HEALTHY              every layer is fresh
 *   ⚠ DEGRADED             at least one layer is slow but writes are
 *                          happening somewhere
 *   ✗ STALE                no writes in the last hour anywhere — workers
 *                          are dead (PM2 / scheduler not running)
 *
 * Usage:
 *   npx tsx scripts/checkDatabaseFreshness.ts
 *   npx tsx scripts/checkDatabaseFreshness.ts --json   # machine-readable
 *
 * Exit codes:  0 = healthy, 1 = degraded, 2 = stale, 3 = error.
 *
 * Designed to be cron-runnable so an external monitor can alert when
 * the DB stops updating.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

interface LayerProbe {
  name:               string;
  table:              string;
  ts_column:          string;
  fresh_threshold_min: number;
  slow_threshold_min:  number;
  /** Filter clause appended to WHERE (no leading AND). Empty = no filter. */
  where:               string;
}

const LAYERS: LayerProbe[] = [
  {
    name:                'q365_signals (scanner output)',
    table:               'q365_signals',
    ts_column:           'generated_at',
    fresh_threshold_min: 15,
    slow_threshold_min:  60,
    where:               '',
  },
  {
    name:                'q365_confirmed_signal_snapshots (promotions)',
    table:               'q365_confirmed_signal_snapshots',
    ts_column:           'confirmed_at',
    fresh_threshold_min: 30,   // promotions are rarer; 30 min is healthy
    slow_threshold_min:  120,
    where:               '',
  },
  {
    name:                'q365_signal_maturity_tracker (maturity worker)',
    table:               'q365_signal_maturity_tracker',
    ts_column:           'last_seen_at',
    fresh_threshold_min: 5,    // worker runs every 60s; 5 min = stale
    slow_threshold_min:  15,
    where:               '',
  },
  {
    name:                'market_data_daily (candle ingest)',
    table:               'market_data_daily',
    ts_column:           'ts',
    fresh_threshold_min: 30,   // candles refresh every 15 min
    slow_threshold_min:  90,
    where:               '',
  },
];

interface LayerResult {
  name:             string;
  exists:           boolean;
  latest_at:        string | null;
  age_minutes:      number | null;
  rows_last_5min:   number;
  rows_last_60min:  number;
  status:           'fresh' | 'slow' | 'stale' | 'missing';
  threshold_fresh:  number;
  threshold_slow:   number;
  error:            string | null;
}

async function probeLayer(L: LayerProbe): Promise<LayerResult> {
  const result: LayerResult = {
    name:            L.name,
    exists:          true,
    latest_at:       null,
    age_minutes:     null,
    rows_last_5min:  0,
    rows_last_60min: 0,
    status:          'stale',
    threshold_fresh: L.fresh_threshold_min,
    threshold_slow:  L.slow_threshold_min,
    error:           null,
  };

  const whereClause = L.where ? `WHERE ${L.where}` : '';
  try {
    const { rows } = await db.query<{ latest_ts: number | null; n5: number; n60: number }>(
      `SELECT
         UNIX_TIMESTAMP(MAX(${L.ts_column})) AS latest_ts,
         SUM(CASE WHEN ${L.ts_column} >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)  THEN 1 ELSE 0 END) AS n5,
         SUM(CASE WHEN ${L.ts_column} >= DATE_SUB(NOW(), INTERVAL 60 MINUTE) THEN 1 ELSE 0 END) AS n60
       FROM ${L.table}
       ${whereClause}`,
    );
    const r: any = rows[0] ?? {};
    if (r.latest_ts != null) {
      const ms = Number(r.latest_ts) * 1000;
      result.latest_at = new Date(ms).toISOString();
      result.age_minutes = Math.round((Date.now() - ms) / 60000 * 10) / 10;
    }
    result.rows_last_5min  = Number(r.n5  ?? 0);
    result.rows_last_60min = Number(r.n60 ?? 0);

    if (result.age_minutes == null) {
      result.status = 'stale';   // table is empty
    } else if (result.age_minutes <= L.fresh_threshold_min) {
      result.status = 'fresh';
    } else if (result.age_minutes <= L.slow_threshold_min) {
      result.status = 'slow';
    } else {
      result.status = 'stale';
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (/doesn'?t exist|unknown table/i.test(msg)) {
      result.exists = false;
      result.status = 'missing';
    } else {
      result.error = msg;
    }
  }
  return result;
}

function fmt(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number') return String(v);
  return String(v);
}

function statusGlyph(s: LayerResult['status']): string {
  switch (s) {
    case 'fresh':   return '✓ fresh';
    case 'slow':    return '⚠ slow ';
    case 'stale':   return '✗ stale';
    case 'missing': return '✗ missing';
  }
}

async function main(): Promise<void> {
  const isJson = process.argv.includes('--json');

  if (!isJson) {
    console.log();
    console.log('Database freshness probe');
    console.log('='.repeat(96));
    console.log(`Scope:  every writer that should be active during normal operation`);
    console.log(`Time :  ${new Date().toISOString()}`);
    console.log();
  }

  const results: LayerResult[] = [];
  for (const L of LAYERS) {
    results.push(await probeLayer(L));
  }

  if (isJson) {
    console.log(JSON.stringify({
      checked_at: new Date().toISOString(),
      layers:     results,
    }, null, 2));
  } else {
    // Pretty table
    const colName = 48;
    const colAge  = 14;
    const col5    = 11;
    const col60   = 11;
    const colSt   = 11;
    console.log(
      'Layer'.padEnd(colName) +
      'age (min)'.padEnd(colAge) +
      'last 5min'.padEnd(col5) +
      'last 60min'.padEnd(col60) +
      'status'.padEnd(colSt),
    );
    console.log('-'.repeat(colName + colAge + col5 + col60 + colSt));
    for (const r of results) {
      const ageStr = r.age_minutes == null ? '—' : `${r.age_minutes}`;
      console.log(
        r.name.padEnd(colName) +
        ageStr.padEnd(colAge) +
        fmt(r.rows_last_5min).padEnd(col5) +
        fmt(r.rows_last_60min).padEnd(col60) +
        statusGlyph(r.status).padEnd(colSt),
      );
      if (r.error) console.log(`  └─ error: ${r.error}`);
      if (!r.exists) console.log(`  └─ table missing — run migrateSignalEngine`);
    }
    console.log();
  }

  // Verdict
  const writes60 = results.reduce((acc, r) => acc + r.rows_last_60min, 0);
  const anyStale = results.some((r) => r.status === 'stale' && r.exists);
  const anySlow  = results.some((r) => r.status === 'slow');
  const allFresh = results.every((r) => r.status === 'fresh' || !r.exists);

  let verdict: 'HEALTHY' | 'DEGRADED' | 'STALE';
  let exitCode = 0;
  let summary = '';

  if (writes60 === 0) {
    verdict = 'STALE';
    exitCode = 2;
    summary = 'No writes in the last hour anywhere. Workers (PM2 scheduler / candle / regen) are likely dead.';
  } else if (anyStale) {
    verdict = 'DEGRADED';
    exitCode = 1;
    summary = 'Some layers are writing, others are stale. Check the per-layer "✗ stale" lines above.';
  } else if (anySlow) {
    verdict = 'DEGRADED';
    exitCode = 1;
    summary = 'All layers writing but some are slower than expected. Likely DB pressure or rate-limited upstream.';
  } else if (allFresh) {
    verdict = 'HEALTHY';
    exitCode = 0;
    summary = 'All layers are writing within their fresh-threshold windows.';
  } else {
    verdict = 'DEGRADED';
    exitCode = 1;
    summary = 'Mixed state.';
  }

  if (isJson) {
    // JSON path already printed; append verdict to stderr so it shows
    // separately when redirecting stdout to a file.
    process.stderr.write(JSON.stringify({ verdict, exit_code: exitCode, summary }) + '\n');
  } else {
    const glyph = verdict === 'HEALTHY' ? '✓' : verdict === 'DEGRADED' ? '⚠' : '✗';
    console.log('='.repeat(96));
    console.log(`Verdict:  ${glyph} ${verdict}`);
    console.log(`          ${summary}`);
    if (verdict !== 'HEALTHY') {
      console.log();
      console.log('Quick triage:');
      console.log('  • pm2 logs --lines 100  | grep -E "scheduler|REGEN|exited"');
      console.log('  • ls -la nse_stocks_list.xlsx   (custom-universe scanner needs it)');
      console.log('  • mysql ... SHOW PROCESSLIST  (look for runaway queries)');
      console.log('  • top -b -n 1 | head -10      (CPU load + mysqld %)');
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('FATAL:', err?.message ?? err);
  process.exit(3);
});
