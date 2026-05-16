/**
 * Diagnose why "/api/signals" reports
 *   [WARNING] FILTER TOO STRICT — only 0 rows eligible.
 *
 * Walks the entire pipeline from DB → engine → strict gate and prints
 * how many rows survive each stage. Tells you exactly which stage
 * killed the signals so you don't have to grep through engine logs.
 *
 * Run:
 *   cd /var/www/api-update
 *   npx tsx scripts/diagnoseSignalFunnel.ts
 */

// Load .env.local before anything imports `db` — the codebase
// convention (server.js + every other script does the same). Plain
// `dotenv/config` only reads `.env`, which this repo doesn't use.
import * as path                 from 'node:path';
import { config as loadEnv }     from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db }                       from '../src/lib/db';
import { getActiveSignals }         from '../src/lib/signal-engine/repository/readSignals';
import { applyLiveSanity }          from '../src/lib/signal-engine/live/validateAgainstLive';
import { MAIN_TABLE_CLASSIFICATIONS } from '../src/lib/signal-engine/pipeline/phase12Routing';

const BAR = '═'.repeat(60);
const SUB = '─'.repeat(60);

function bar(title: string): void {
  console.log('\n' + BAR);
  console.log('  ' + title);
  console.log(BAR);
}
function sub(title: string): void {
  console.log('\n' + SUB);
  console.log('  ' + title);
  console.log(SUB);
}

async function main() {
  bar('SIGNAL FUNNEL DIAGNOSTIC');
  console.log('Run at:', new Date().toISOString());

  // ── Stage 1: Raw DB state ───────────────────────────────────
  sub('1. q365_signals table state');
  const tableState = await db.query(`
    SELECT
      COUNT(*)                                                  AS total,
      SUM(status = 'active')                                    AS active,
      SUM(status = 'watchlist')                                 AS watchlist,
      SUM(status = 'flagged')                                   AS flagged,
      SUM(decay_state = 'expired')                              AS expired,
      SUM(invalidation_reason IS NOT NULL)                      AS invalidated,
      SUM(expires_at IS NOT NULL AND expires_at < NOW())        AS time_expired,
      SUM(signal_status = 'APPROVED_SIGNAL')                    AS approved,
      SUM(signal_status = 'DEVELOPING_SETUP')                   AS developing,
      SUM(signal_status = 'NO_TRADE')                           AS no_trade,
      MAX(generated_at)                                         AS newest,
      MIN(generated_at)                                         AS oldest,
      COUNT(DISTINCT batch_id)                                  AS batches
    FROM q365_signals;
  `);
  const t = (tableState.rows as any[])[0] ?? {};
  console.log('  total rows         :', t.total);
  console.log('  active             :', t.active);
  console.log('  watchlist          :', t.watchlist);
  console.log('  flagged            :', t.flagged);
  console.log('  decay=expired      :', t.expired);
  console.log('  invalidated        :', t.invalidated);
  console.log('  time-expired       :', t.time_expired);
  console.log('  signal_status APP  :', t.approved);
  console.log('  signal_status DEV  :', t.developing);
  console.log('  signal_status N/T  :', t.no_trade);
  console.log('  distinct batches   :', t.batches);
  console.log('  newest signal at   :', t.newest);
  console.log('  oldest signal at   :', t.oldest);

  if (Number(t.total) === 0) {
    console.log('\n  ✗ DIAGNOSIS: q365_signals is EMPTY. Engine has never run.');
    console.log('  → Fix: trigger a scan');
    console.log('     curl -X POST http://localhost:3000/api/scanner/custom-universe/run \\');
    console.log("        -H 'Content-Type: application/json' \\");
    console.log('        -d \'{"async":true,"concurrency":32,"dryRun":false}\'');
    process.exit(0);
  }

  // ── Stage 2: Latest batch breakdown ─────────────────────────
  sub('2. Latest batch only');
  const latestBatch = await db.query(`
    SELECT batch_id FROM q365_signals
    WHERE batch_id IS NOT NULL
    ORDER BY generated_at DESC LIMIT 1;
  `);
  const batchId = (latestBatch.rows as any[])[0]?.batch_id;
  console.log('  latest batch_id    :', batchId ?? '<NONE>');
  if (batchId) {
    const lb = await db.query(
      `SELECT
         COUNT(*)                                AS total,
         SUM(direction='BUY')                    AS buy,
         SUM(direction='SELL')                   AS sell,
         SUM(classification='HIGH_CONVICTION_BUY') AS hcb,
         SUM(classification='VALID_BUY')         AS valid_buy,
         SUM(classification='REJECT')            AS reject_classify,
         AVG(final_score)                        AS avg_final,
         AVG(confidence_score)                   AS avg_conf,
         MIN(final_score)                        AS min_final,
         MAX(final_score)                        AS max_final
       FROM q365_signals WHERE batch_id = ?;`,
      [batchId],
    );
    const b = (lb.rows as any[])[0] ?? {};
    console.log('  rows in batch      :', b.total);
    console.log('  BUY / SELL         :', b.buy, '/', b.sell);
    console.log('  HIGH_CONVICTION_BUY:', b.hcb);
    console.log('  VALID_BUY          :', b.valid_buy);
    console.log('  REJECT             :', b.reject_classify);
    console.log('  final_score range  :', Number(b.min_final).toFixed(1), '→', Number(b.max_final).toFixed(1));
    console.log('  avg final / conf   :', Number(b.avg_final).toFixed(1), '/', Number(b.avg_conf).toFixed(1));
  }

  // ── Stage 3: getActiveSignals output ────────────────────────
  sub('3. getActiveSignals(100, latestBatchOnly=true) — what the API reads');
  const fromRepo = await getActiveSignals(100, { latestBatchOnly: true });
  console.log('  rows returned      :', fromRepo.length);
  if (fromRepo.length === 0) {
    console.log('\n  ✗ Repository returned 0 rows. Common reasons:');
    console.log('    - All rows in latest batch have status NOT IN (active, watchlist, flagged)');
    console.log('    - All rows have decay_state = "expired"');
    console.log('    - All rows have hard invalidation_reason set');
    console.log('    - All rows have signal_status = DEVELOPING_SETUP or NO_TRADE');
    console.log('    - All rows have final_score < 30');
  } else {
    const dirCount = fromRepo.reduce((acc: any, r: any) => {
      const d = String(r.direction ?? '').toUpperCase();
      acc[d] = (acc[d] ?? 0) + 1;
      return acc;
    }, {});
    console.log('  by direction       :', JSON.stringify(dirCount));
  }

  // ── Stage 4: applyLiveSanity ────────────────────────────────
  sub('4. After applyLiveSanity()');
  applyLiveSanity(fromRepo as any[]);
  const liveInvalidated = fromRepo.filter((r: any) => r.live_invalidated === true).length;
  const driftDowngraded = fromRepo.filter((r: any) => r.live_drift_downgrade === true).length;
  console.log('  live_invalidated   :', liveInvalidated);
  console.log('  drift_downgrade    :', driftDowngraded);
  console.log('  remaining usable   :', fromRepo.length - liveInvalidated - driftDowngraded);

  // ── Stage 5: Strict gate (matches /signals + /intelligence) ─
  sub('5. Strict gate filtering');
  const HARD_INVALIDATIONS = new Set([
    'stop_loss_broken', 'stop_loss_broken_confirmed',
    'target_reached', 'target_already_reached',
    'engine_disagree', 'live_rejected',
  ]);
  const dropReasons: Record<string, number> = {};
  const bump = (k: string) => { dropReasons[k] = (dropReasons[k] ?? 0) + 1; };

  const survivors = fromRepo.filter((r: any) => {
    if (r.live_invalidated === true)        { bump('live_invalidated'); return false; }
    if (r.live_drift_downgrade === true)    { bump('drift_downgrade');  return false; }
    const inv = String(r.invalidation_reason ?? '').toLowerCase();
    if (inv && HARD_INVALIDATIONS.has(inv)) { bump('hard_invalidation:' + inv); return false; }
    if (String(r.decay_state ?? '').toLowerCase() === 'expired')  { bump('decay_expired'); return false; }
    if (String(r.conviction_band ?? '').toLowerCase() === 'reject'){ bump('conviction_reject'); return false; }
    const klass = String(r.classification ?? '').toUpperCase();
    if (!MAIN_TABLE_CLASSIFICATIONS.has(klass)) { bump('classification:' + (klass || '<NULL>')); return false; }
    const conf  = Number(r.confidence_score ?? r.confidence ?? 0);
    const score = Math.max(
      Number(r.final_score       ?? 0),
      Number(r.opportunity_score ?? 0),
      Number(r.confidence_score  ?? 0),
    );
    if (!(score >= 50 && conf >= 50)) { bump(`score<50_or_conf<50 (s=${score.toFixed(0)}/c=${conf.toFixed(0)})`); return false; }
    return true;
  });

  console.log('  survivors          :', survivors.length, '/', fromRepo.length);
  if (Object.keys(dropReasons).length > 0) {
    console.log('  drop reasons:');
    Object.entries(dropReasons)
      .sort((a, b) => b[1] - a[1])
      .forEach(([reason, n]) => console.log(`    ${String(n).padStart(4)} × ${reason}`));
  }

  // ── Stage 6: Final diagnosis ────────────────────────────────
  bar('DIAGNOSIS');
  if (survivors.length >= 30) {
    console.log('  ✓ HEALTHY — ' + survivors.length + ' rows pass the strict gate.');
    console.log('  The "FILTER TOO STRICT" warning should not be firing now.');
    console.log('  If it is, check that your app process has restarted since the');
    console.log('  most recent batch was written.');
  } else if (survivors.length === 0 && fromRepo.length === 0) {
    console.log('  ✗ NO ROWS in latest batch.');
    console.log('  → The scanner has not produced a batch yet, or every row was rejected at write time.');
    console.log('  → Trigger: curl -X POST http://localhost:3000/api/scanner/custom-universe/run \\');
    console.log("              -H 'Content-Type: application/json' \\");
    console.log('              -d \'{"async":true,"concurrency":32,"dryRun":false}\'');
  } else if (survivors.length === 0 && fromRepo.length > 0) {
    console.log('  ✗ Rows exist but ALL filtered out at the strict gate.');
    console.log('  → See "drop reasons" above for the dominant cause.');
    const top = Object.entries(dropReasons).sort((a, b) => b[1] - a[1])[0];
    if (top) {
      console.log('  → Top reason:', top[0], '(' + top[1] + ' rows)');
      if (top[0].startsWith('classification')) {
        console.log('     The engine produced rows but none were classified as HIGH_CONVICTION_BUY / VALID_BUY.');
        console.log('     Likely a sideways/strict regime. Trigger a fresh scan to refresh.');
      } else if (top[0] === 'decay_expired') {
        console.log('     All rows have decayed. The rescore cron is not running or the last batch is too old.');
      } else if (top[0].startsWith('score<50')) {
        console.log('     Rows are weak (final_score < 50 or confidence < 50). Engine pool is starved.');
      }
    }
  } else {
    console.log('  ⚠ Thin batch — ' + survivors.length + ' rows pass (target ≥ 30).');
    console.log('  → Trigger a fresh scan, or check rescore cadence.');
  }

  console.log('\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n[diagnose] FAILED:', err?.message ?? err);
  process.exit(1);
});
