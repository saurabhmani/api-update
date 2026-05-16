/**
 * scripts/debugSellFunnel.ts
 *
 * Read-side SELL diagnostic. Runs against whatever DB .env.local
 * points at, with no auth / no HTTP. On the VPS, run this AFTER
 * `git pull && npm run build && pm2 restart` so it exercises the
 * deployed code path:
 *
 *   npx tsx scripts/debugSellFunnel.ts
 *
 * Reports:
 *   1. SELL survival funnel — which gate kills how many rows
 *   2. 20 sample SELL rows from the latest adapter batch
 *   3. The exact rows getActiveSignals(100) returns + their direction split
 *   4. Diagnosis: which condition (if any) is dropping SELLs
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { getActiveSignals } from '../src/lib/signal-engine/repository/readSignals';

function bar(label: string) {
  console.log('\n' + '═'.repeat(78));
  console.log(label);
  console.log('═'.repeat(78));
}

const FUNNEL_QUERY = `
WITH base AS (
  SELECT * FROM q365_signals WHERE direction = 'SELL'
)
SELECT 'A. total SELL rows in q365_signals' AS stage, COUNT(*) c FROM base
UNION ALL SELECT 'B. + status IN (active,watchlist,flagged)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged')
UNION ALL SELECT 'C. + invalidation_reason IS NULL', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
UNION ALL SELECT 'D. + (expires_at IS NULL OR > NOW())', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
UNION ALL SELECT 'E. + decay_state != expired', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
UNION ALL SELECT 'F. + signal_status IS NULL OR APPROVED_SIGNAL', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
UNION ALL SELECT 'G. + final_score IS NULL OR >= 50  (THIS IS THE READ-SIDE SQL CUTOFF)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND (final_score IS NULL OR final_score >= 50)
UNION ALL SELECT 'H. + final_score >= 65  (route-side Tier-3 floor)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65
UNION ALL SELECT 'I. + confidence_score >= 60', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60
UNION ALL SELECT 'J. + risk_score <= 70', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
UNION ALL SELECT 'K. + risk_reward >= 1.5', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state <> 'expired'
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
    AND risk_reward >= 1.5
UNION ALL SELECT 'L. + decay_state NOT IN (expired,stale)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state NOT IN ('expired','stale')
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
    AND risk_reward >= 1.5
UNION ALL SELECT 'M. + classification IN (main-table set)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state NOT IN ('expired','stale')
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
    AND risk_reward >= 1.5
    AND classification IN ('VALID_BUY','HIGH_CONVICTION_BUY','VALID_SIGNAL','HIGH_CONVICTION','INSTITUTIONAL_HIGH_CONVICTION')
UNION ALL SELECT 'N. + (live_valid IS NULL OR live_valid = 1)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state NOT IN ('expired','stale')
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
    AND risk_reward >= 1.5
    AND classification IN ('VALID_BUY','HIGH_CONVICTION_BUY','VALID_SIGNAL','HIGH_CONVICTION','INSTITUTIONAL_HIGH_CONVICTION')
    AND (live_valid IS NULL OR live_valid = 1)
UNION ALL SELECT 'O. + (stress_survival_score IS NULL OR >= 60)', COUNT(*) FROM base
  WHERE status IN ('active','watchlist','flagged') AND invalidation_reason IS NULL
    AND (expires_at IS NULL OR expires_at > NOW()) AND decay_state NOT IN ('expired','stale')
    AND (signal_status IS NULL OR signal_status = 'APPROVED_SIGNAL')
    AND final_score >= 65 AND confidence_score >= 60 AND risk_score <= 70
    AND risk_reward >= 1.5
    AND classification IN ('VALID_BUY','HIGH_CONVICTION_BUY','VALID_SIGNAL','HIGH_CONVICTION','INSTITUTIONAL_HIGH_CONVICTION')
    AND (live_valid IS NULL OR live_valid = 1)
    AND (stress_survival_score IS NULL OR stress_survival_score >= 60)`;

async function main() {
  bar('SELL SURVIVAL FUNNEL — read-side gates, all SELL rows in DB');
  const funnel = await db.query<any>(FUNNEL_QUERY);
  let prev: number | null = null;
  for (const row of funnel.rows as any[]) {
    const c = Number(row.c);
    const drop = prev != null ? prev - c : 0;
    const dropTag = drop > 0 ? `  (-${drop})` : '';
    console.log(`  ${row.stage.padEnd(60)} ${String(c).padStart(6)}${dropTag}`);
    prev = c;
  }

  // ── 2. Sample 20 SELL rows from the latest adapter batch ────────
  bar('SAMPLE 20 SELL ROWS — latest api:run-signal-engine:adapter batch');
  const adapterBatch = await db.query<any>(`
    SELECT batch_id, MAX(generated_at) ts FROM q365_signals
    WHERE generation_source = 'api:run-signal-engine:adapter' AND batch_id IS NOT NULL
    GROUP BY batch_id ORDER BY ts DESC LIMIT 1`);
  const latestAdapter = (adapterBatch.rows[0] as any)?.batch_id ?? null;
  if (!latestAdapter) {
    console.log('  No api:run-signal-engine:adapter batch in this DB — fall back to ANY most-recent batch.');
  } else {
    console.log(`  latest adapter batch_id: ${latestAdapter}\n`);
  }
  const sampleQ = latestAdapter
    ? `SELECT symbol, direction, status, signal_status, classification,
              final_score, confidence_score, risk_score, risk_reward,
              stress_survival_score, live_valid, decay_state, generated_at,
              rejection_reasons_json
       FROM q365_signals
       WHERE direction='SELL' AND batch_id = ?
       ORDER BY final_score DESC LIMIT 20`
    : `SELECT symbol, direction, status, signal_status, classification,
              final_score, confidence_score, risk_score, risk_reward,
              stress_survival_score, live_valid, decay_state, generated_at,
              rejection_reasons_json
       FROM q365_signals
       WHERE direction='SELL'
       ORDER BY generated_at DESC, final_score DESC LIMIT 20`;
  const sample = await db.query<any>(sampleQ, latestAdapter ? [latestAdapter] : []);
  if (sample.rows.length === 0) {
    console.log('  ZERO SELL ROWS FOUND in target batch.');
    console.log('  → The pipeline that wrote this batch did not emit any SELL signals.');
    console.log('    This is the ROOT CAUSE if "DB has many SELL rows" referred to OLDER batches.');
    console.log('    Latest adapter batch contains zero SELL → /api/signals correctly returns 0 SELL.\n');
  } else {
    console.log('  symbol      dir   status     sig_status         classification              fs   conf  risk  rr    stress  live decay');
    for (const r of sample.rows as any[]) {
      console.log(
        `  ${String(r.symbol ?? '').padEnd(11)} ` +
        `${String(r.direction ?? '').padEnd(4)} ` +
        `${String(r.status ?? '').padEnd(10)} ` +
        `${String(r.signal_status ?? '').padEnd(18)} ` +
        `${String(r.classification ?? '').padEnd(28)} ` +
        `${String(r.final_score ?? '').padStart(5)} ` +
        `${String(r.confidence_score ?? '').padStart(5)} ` +
        `${String(r.risk_score ?? '').padStart(4)} ` +
        `${String(r.risk_reward ?? '').padStart(5)} ` +
        `${String(r.stress_survival_score ?? '').padStart(6)} ` +
        `${r.live_valid == null ? 'null' : r.live_valid ? '   1' : '   0'} ` +
        `${String(r.decay_state ?? '')}`
      );
    }
  }

  // ── 3. What does getActiveSignals(100) actually return? ──────────
  bar('LIVE getActiveSignals(100) RESULT — exercises the deployed read-side SQL');
  const t0 = Date.now();
  const rows = await getActiveSignals(100);
  const elapsed = Date.now() - t0;
  let buyN = 0, sellN = 0;
  for (const r of rows) {
    const d = String((r as any).direction ?? '').toUpperCase();
    if (d === 'BUY') buyN++;
    if (d === 'SELL') sellN++;
  }
  console.log(`  fetched ${rows.length} rows in ${elapsed}ms`);
  console.log(`  BUY:  ${buyN}`);
  console.log(`  SELL: ${sellN}`);

  // ── 4. Diagnosis ─────────────────────────────────────────────────
  bar('DIAGNOSIS');
  const funnelRows = funnel.rows as any[];
  const final = Number(funnelRows[funnelRows.length - 1]?.c ?? 0);
  const stageF = Number(funnelRows.find((r) => r.stage.startsWith('F.'))?.c ?? 0);
  const stageA = Number(funnelRows[0]?.c ?? 0);
  const stageH = Number(funnelRows.find((r) => r.stage.startsWith('H.'))?.c ?? 0);
  const stageO = Number(funnelRows.find((r) => r.stage.startsWith('O.'))?.c ?? 0);

  if (stageA === 0) {
    console.log('  ✗ Zero SELL rows in q365_signals.');
    console.log('    The pipeline never emitted SELL signals — the read-side cannot conjure them.');
    console.log('    Fix on the WRITE side:');
    console.log('      - run the Yahoo scanner (more permissive, produces both directions in any regime)');
    console.log('        npx tsx scripts/generateOneBatch.ts --scanner --full');
    console.log('      - OR investigate the strategy registry; bearish strategies may be regime-blocked');
    console.log('        (overbought_reversal + weak_trend_breakdown blocked in STRONG_BULLISH).');
  } else if (stageF < stageA) {
    console.log(`  ⚠ ${stageA - stageF} SELL rows have signal_status != APPROVED_SIGNAL.`);
    console.log('    This is normal — DEVELOPING_SETUP rows go to emerging, not main table.');
    console.log(`    APPROVED SELL count: ${stageF}`);
  }
  if (stageF > 0 && stageH < stageF) {
    console.log(`  ⚠ ${stageF - stageH} APPROVED SELLs fail final_score >= 65.`);
    console.log('    These survive the SQL (>=50) but fail the route-side Tier-3 floor.');
  }
  if (stageH > 0 && stageO < stageH) {
    console.log(`  ⚠ ${stageH - stageO} SELLs fail Phase-12 stress/live/classification gate.`);
  }
  if (final >= 1 && sellN === 0) {
    console.log('  ✗ FUNNEL SAYS SELLs SHOULD SURVIVE (final stage = ' + final + '),');
    console.log('    BUT getActiveSignals(100) RETURNED ZERO SELL.');
    console.log('    → The deployed SQL doesn\'t have the per-direction window function fix.');
    console.log('    → Force a clean rebuild on the VPS:');
    console.log('        cd /var/www/api-update');
    console.log('        rm -rf .next node_modules/.cache');
    console.log('        npm run build 2>&1 | tail -30');
    console.log('        pm2 restart quantorus365-app --update-env');
  } else if (final >= 1 && sellN >= 1) {
    console.log('  ✓ getActiveSignals(100) IS surfacing SELLs correctly.');
    console.log(`    Final SQL pass: ${final} SELL eligible — ${sellN} delivered after dedup quotas.`);
  } else if (final === 0 && stageA > 0) {
    console.log('  ✗ All SELL rows fail at least one read-side gate.');
    if (stageF > 0 && stageH === 0) {
      console.log('    Specifically: zero APPROVED SELLs have final_score >= 65.');
      console.log('    This is a WRITE-SIDE issue — the engine wrote SELLs with low final_score.');
    }
    if (stageO === 0 && stageH > 0) {
      console.log('    Specifically: every gated SELL fails stress / live_valid / classification.');
      console.log('    Inspect the 20 sample rows above for the dominant rejection field.');
    }
  }

  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
