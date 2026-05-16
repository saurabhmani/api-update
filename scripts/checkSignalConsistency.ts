/**
 * scripts/checkSignalConsistency.ts
 *
 * Acceptance test for the "Signals page vs stock-detail page" mismatch
 * fix. The bug: a stock could appear as BUY on /signals while
 * /market/<sym> showed REJECTED / NO_STRATEGY for the same symbol.
 * The fix routes both pages through the same authoritative source
 * (latest non-invalidated q365_signals row, with live revalidation
 * as enrichment).
 *
 * What this script does:
 *   1. Reads the top N BUY signals exactly as the dashboard does
 *      (getActiveSignals + the same in-memory filters used by the
 *      route handler — see strictHardExclude in src/app/api/signals/
 *      route.ts).
 *   2. For each, calls revalidateInstrument() — the same function
 *      GET /api/signals?action=instrument now uses, so this script
 *      mirrors what the user would see in the stock-detail page.
 *   3. Reports any mismatch:
 *        • direction differs between table and detail
 *        • detail signal_status is REJECTED / NO_TRADE
 *        • detail scenario_tag is NO_STRATEGY
 *        • classification downgrade unexplained by revalidation
 *
 * Usage:
 *   npx tsx scripts/checkSignalConsistency.ts                # top 10 BUY
 *   npx tsx scripts/checkSignalConsistency.ts --limit 25     # top 25 BUY
 *   npx tsx scripts/checkSignalConsistency.ts --no-persist   # don't write invalidations
 *
 * Exit code: 0 on perfect consistency; 1 if any mismatch is found.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db }                  from '../src/lib/db';
import { getActiveSignals }    from '../src/lib/signal-engine/repository/readSignals';
import { revalidateInstrument } from '../src/lib/signal-engine/live/revalidateInstrument';

interface Args {
  limit:        number;
  noPersist:    boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let limit = 10;
  let noPersist = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      limit = Math.max(1, Math.min(100, Number(argv[++i]) || 10));
    } else if (argv[i] === '--no-persist') {
      noPersist = true;
    }
  }
  return { limit, noPersist };
}

function bar(label: string) {
  console.log('\n' + '═'.repeat(78));
  console.log(label);
  console.log('═'.repeat(78));
}

interface Mismatch {
  symbol:        string;
  table_direction: string;
  detail_direction: string | null;
  detail_status:   string | null;
  detail_scenario: string | null;
  reasons:         string[];
  revalidation:    string;
}

async function main() {
  const args = parseArgs();
  bar(`Signal consistency check — top ${args.limit} BUY signals`);

  // 1. Fetch the same pool the API serves — getActiveSignals already
  // filters status / invalidation / decay / signal_status. We add the
  // same numeric gates the route's strictHardExclude enforces so the
  // sample matches what the dashboard actually shows.
  const pool = await getActiveSignals(Math.max(50, args.limit * 4));
  const buys = pool.filter((r: any) => {
    const dir = String(r.direction ?? '').toUpperCase();
    if (dir !== 'BUY') return false;
    if (r.live_invalidated === true) return false;
    if (r.invalidation_reason && String(r.invalidation_reason).length > 0) return false;
    const conf = Number(r.confidence_score ?? r.confidence ?? 0);
    const risk = Number(r.risk_score ?? 100);
    const rr   = Number(r.risk_reward ?? 0);
    if (conf < 60) return false;
    if (risk > 70) return false;
    if (rr   < 1.5) return false;
    if (String(r.signal_status ?? '') !== 'APPROVED_SIGNAL') return false;
    return true;
  }).slice(0, args.limit);

  if (buys.length === 0) {
    console.log('No BUY signals available — nothing to check.');
    process.exit(0);
  }

  console.log(`Found ${buys.length} BUY rows in /api/signals top pool.\n`);
  console.log('SYMBOL'.padEnd(14) + 'TABLE'.padEnd(8) + 'DETAIL'.padEnd(8) + 'STATUS'.padEnd(20) + 'SCENARIO'.padEnd(22) + 'REVAL');
  console.log('─'.repeat(78));

  const mismatches: Mismatch[] = [];

  for (const row of buys) {
    const sym  = String(row.symbol ?? row.tradingsymbol ?? '').toUpperCase();
    const ikey = String(row.instrument_key ?? `NSE_EQ|${sym}`);
    const exch = String(row.exchange ?? 'NSE');
    if (!sym) continue;

    let detail;
    try {
      detail = await revalidateInstrument(ikey, sym, exch, {
        persistInvalidation: !args.noPersist,
      });
    } catch (err: any) {
      console.log(
        sym.padEnd(14) +
        'BUY'.padEnd(8) +
        'ERR'.padEnd(8) +
        `(${err?.message ?? 'threw'})`.padEnd(20) +
        ''.padEnd(22) +
        '—',
      );
      mismatches.push({
        symbol:           sym,
        table_direction:  'BUY',
        detail_direction: null,
        detail_status:    null,
        detail_scenario:  null,
        reasons:          [`revalidateInstrument threw: ${err?.message ?? err}`],
        revalidation:     'error',
      });
      continue;
    }

    const liveStatus    = detail.revalidation.live?.signal_status ?? null;
    const liveScenario  = (detail.signal as any)?.scenario_tag ?? null;
    const detailDir     = (detail.signal as any)?.direction ?? null;
    const revalStatus   = detail.revalidation.status;

    const failures: string[] = [];

    // Direction must match the table (revalidated case is allowed
    // since the displayed direction stays = stored direction).
    if (detailDir && detailDir.toUpperCase() !== 'BUY') {
      failures.push(`direction mismatch: table=BUY detail=${detailDir}`);
    }

    // Live engine returning NO_TRADE / DEVELOPING_SETUP without the
    // revalidation envelope flagging it is the exact bug we just
    // fixed — guard against regression.
    if ((liveStatus === 'NO_TRADE' || liveStatus === 'DEVELOPING_SETUP') && revalStatus !== 'revalidated') {
      failures.push(`live=${liveStatus} but revalidation=${revalStatus} (expected 'revalidated')`);
    }

    // NO_STRATEGY surfacing on a BUY row — caught by 'revalidated'
    // banner. Only flag if it leaks into approved=true with no banner.
    if (liveScenario === 'NO_STRATEGY' && revalStatus === 'consistent') {
      failures.push(`scenario=NO_STRATEGY on a 'consistent' result — should be 'revalidated'`);
    }

    // Pure rejection (approved=false) on a row that the table
    // showed as APPROVED is by definition a regression.
    if (detail.approved === false && revalStatus !== 'live_only') {
      failures.push(`approved=false on a stored-APPROVED row (revalidation=${revalStatus})`);
    }

    const ok = failures.length === 0;
    const tag = ok
      ? (revalStatus === 'consistent' ? 'OK' : revalStatus.toUpperCase())
      : 'MISMATCH';

    console.log(
      sym.padEnd(14) +
      'BUY'.padEnd(8) +
      String(detailDir ?? '—').padEnd(8) +
      String(liveStatus ?? '—').padEnd(20) +
      String(liveScenario ?? '—').padEnd(22) +
      tag,
    );

    if (!ok) {
      mismatches.push({
        symbol:           sym,
        table_direction:  'BUY',
        detail_direction: detailDir,
        detail_status:    liveStatus,
        detail_scenario:  liveScenario,
        reasons:          failures,
        revalidation:     revalStatus,
      });
    }
  }

  // ── Summary ──────────────────────────────────────────────────
  bar('Summary');
  console.log(`Checked:    ${buys.length}`);
  console.log(`Consistent: ${buys.length - mismatches.length}`);
  console.log(`Mismatches: ${mismatches.length}`);

  if (mismatches.length > 0) {
    bar('Mismatches');
    for (const m of mismatches) {
      console.log(`\n  ${m.symbol}`);
      console.log(`    table direction:   ${m.table_direction}`);
      console.log(`    detail direction:  ${m.detail_direction ?? '—'}`);
      console.log(`    detail status:     ${m.detail_status ?? '—'}`);
      console.log(`    detail scenario:   ${m.detail_scenario ?? '—'}`);
      console.log(`    revalidation tag:  ${m.revalidation}`);
      for (const r of m.reasons) console.log(`    reason:           ${r}`);
    }
  }

  // db is a thin pool wrapper without an .end() method; process.exit
  // tears down the underlying mysql2 pool implicitly. No close call
  // needed.
  void db;
  process.exit(mismatches.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('checkSignalConsistency: fatal', err);
  process.exit(2);
});
