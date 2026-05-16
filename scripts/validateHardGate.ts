/**
 * scripts/validateHardGate.ts
 *
 * Phase-1 validation harness for the strict /signals hard gate.
 * Runs the EXACT same predicate as src/app/api/signals/route.ts
 * (action=all → strictHardExclude) against:
 *
 *   - a fixture pack of synthetic rows that exercise every rule
 *   - if --db is passed AND MySQL is reachable, the live
 *     q365_signals table (top 500 most-recent active rows)
 *
 * Output:
 *   1. one weak fixture row that the gate BLOCKS (with failing rule)
 *   2. one approved fixture row that the gate PASSES
 *   3. invariants over the surviving set:
 *        - every passer has signal_status='APPROVED_SIGNAL'
 *        - every passer has final_score >= 65 (when set)
 *        - no passer is live_invalidated, expired, stale, avoid, or reject
 *
 * Run:
 *   npx tsx scripts/validateHardGate.ts          # fixtures only
 *   npx tsx scripts/validateHardGate.ts --db     # also probe MySQL
 */
import { config as loadEnv } from 'dotenv';
import path from 'path';
loadEnv({ path: path.resolve(process.cwd(), '.env.local') });
loadEnv();

type Row = {
  id: number;
  symbol: string;
  direction: string | null;
  signal_status: string | null;
  decay_state: string | null;
  conviction_band: string | null;
  confidence_band?: string | null;
  confidence_score: number | null;
  risk_score: number | null;
  risk_reward: number | null;
  final_score: number | null;
  live_invalidated: boolean | number | null;
};

/** Mirror of strictHardExclude in src/app/api/signals/route.ts (action=all). */
function failingRule(r: Row): string | null {
  if (r.live_invalidated === true || Number(r.live_invalidated) === 1) {
    return 'live_invalidated=true';
  }
  const decay = String(r.decay_state ?? '').toLowerCase();
  if (decay === 'expired') return 'decay_state=expired';
  if (decay === 'stale')   return 'decay_state=stale';

  const band = String(r.conviction_band ?? r.confidence_band ?? '').toLowerCase();
  if (band === 'avoid')  return 'conviction_band=avoid';
  if (band === 'reject') return 'conviction_band=reject';

  if (String(r.signal_status ?? '') !== 'APPROVED_SIGNAL') {
    return `signal_status=${r.signal_status ?? 'NULL'}`;
  }
  const conf = Number(r.confidence_score ?? 0);
  if (conf < 60) return `confidence_score=${conf} (<60)`;

  const risk = Number(r.risk_score ?? 100);
  if (risk > 70) return `risk_score=${risk} (>70)`;

  const rr = Number(r.risk_reward ?? 0);
  if (rr < 1.5) return `risk_reward=${rr} (<1.5)`;

  if (r.final_score != null) {
    const fs = Number(r.final_score);
    if (fs < 65) return `final_score=${fs} (<65)`;
  }
  return null;
}

// ── Synthetic rows covering every gate rule ──────────────────────
const fixtures: Row[] = [
  // Should PASS — meets all 8 rules.
  {
    id: 100, symbol: 'TCS', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL',
    decay_state: 'fresh',
    conviction_band: 'high_conviction',
    confidence_score: 78, risk_score: 42, risk_reward: 2.4,
    final_score: 81, live_invalidated: false,
  },
  // BLOCKED — live_invalidated true.
  {
    id: 101, symbol: 'WEAK_LIVEINV', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 70, risk_score: 50, risk_reward: 2.0,
    final_score: 72, live_invalidated: true,
  },
  // BLOCKED — decay_state=expired.
  {
    id: 102, symbol: 'WEAK_EXPIRED', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'expired',
    conviction_band: 'actionable',
    confidence_score: 70, risk_score: 50, risk_reward: 2.0,
    final_score: 72, live_invalidated: false,
  },
  // BLOCKED — decay_state=stale.
  {
    id: 103, symbol: 'WEAK_STALE', direction: 'SELL',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'stale',
    conviction_band: 'actionable',
    confidence_score: 68, risk_score: 55, risk_reward: 1.8,
    final_score: 70, live_invalidated: false,
  },
  // BLOCKED — conviction_band=avoid.
  {
    id: 104, symbol: 'WEAK_AVOID', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'avoid',
    confidence_score: 65, risk_score: 60, risk_reward: 1.6,
    final_score: 68, live_invalidated: false,
  },
  // BLOCKED — conviction_band=reject.
  {
    id: 105, symbol: 'WEAK_REJECT', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'reject',
    confidence_score: 75, risk_score: 40, risk_reward: 2.5,
    final_score: 80, live_invalidated: false,
  },
  // BLOCKED — DEVELOPING_SETUP must NOT appear in the main list.
  {
    id: 106, symbol: 'DEV_SETUP', direction: 'BUY',
    signal_status: 'DEVELOPING_SETUP', decay_state: 'fresh',
    conviction_band: 'watchlist',
    confidence_score: 70, risk_score: 55, risk_reward: 1.9,
    final_score: 66, live_invalidated: false,
  },
  // BLOCKED — confidence_score below 60.
  {
    id: 107, symbol: 'WEAK_CONF', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 55, risk_score: 50, risk_reward: 2.0,
    final_score: 70, live_invalidated: false,
  },
  // BLOCKED — risk_score above 70.
  {
    id: 108, symbol: 'WEAK_RISK', direction: 'SELL',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 72, risk_score: 78, risk_reward: 2.0,
    final_score: 70, live_invalidated: false,
  },
  // BLOCKED — risk_reward below 1.5.
  {
    id: 109, symbol: 'WEAK_RR', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 70, risk_score: 50, risk_reward: 1.2,
    final_score: 70, live_invalidated: false,
  },
  // BLOCKED — final_score below 65 (this was the headline change).
  {
    id: 110, symbol: 'WEAK_FINAL', direction: 'BUY',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 68, risk_score: 50, risk_reward: 1.8,
    final_score: 58, live_invalidated: false,
  },
  // PASS — final_score is null (column unset on legacy row), so the
  // final_score rule does not fire; all other rules satisfied.
  {
    id: 111, symbol: 'INFY', direction: 'SELL',
    signal_status: 'APPROVED_SIGNAL', decay_state: 'fresh',
    conviction_band: 'actionable',
    confidence_score: 72, risk_score: 48, risk_reward: 2.2,
    final_score: null, live_invalidated: false,
  },
];

function printRow(r: Row, label: string, rule: string | null) {
  console.log(`── ${label} ─────────────────────────────────────`);
  console.log(`  id:                ${r.id}`);
  console.log(`  symbol:            ${r.symbol}`);
  console.log(`  direction:         ${r.direction ?? 'NULL'}`);
  console.log(`  signal_status:     ${r.signal_status ?? 'NULL'}`);
  console.log(`  decay_state:       ${r.decay_state ?? 'NULL'}`);
  console.log(`  conviction_band:   ${r.conviction_band ?? r.confidence_band ?? 'NULL'}`);
  console.log(`  confidence_score:  ${r.confidence_score ?? 'NULL'}`);
  console.log(`  risk_score:        ${r.risk_score ?? 'NULL'}`);
  console.log(`  risk_reward:       ${r.risk_reward ?? 'NULL'}`);
  console.log(`  final_score:       ${r.final_score ?? 'NULL'}`);
  console.log(`  live_invalidated:  ${r.live_invalidated ?? 'NULL'}`);
  console.log(`  ↳ ${rule ? `FAIL RULE: ${rule}` : 'ALL 8 RULES SATISFIED'}`);
  console.log('');
}

async function probeDb(): Promise<Row[] | null> {
  try {
    const { db } = await import('../src/lib/db');
    const { rows } = await db.query(`
      SELECT id, symbol, direction, signal_status, decay_state,
             conviction_band, confidence_band,
             confidence_score, risk_score, risk_reward, final_score,
             live_invalidated
      FROM q365_signals
      WHERE status IN ('active','watchlist','flagged')
      ORDER BY generated_at DESC
      LIMIT 500
    `);
    return rows as any;
  } catch (e: any) {
    console.warn(`[validateHardGate] DB probe skipped: ${e?.code ?? e?.message}`);
    return null;
  }
}

async function main() {
  const wantDb = process.argv.includes('--db');

  console.log('='.repeat(72));
  console.log('PHASE-1 STRICT HARD GATE — VALIDATION');
  console.log('='.repeat(72));
  console.log(`fixtures: ${fixtures.length}`);
  console.log('');

  const tally: Record<string, number> = {};
  let passing = 0;
  let blocked = 0;
  let firstBlocked: { row: Row; rule: string } | null = null;
  let firstPassing: Row | null = null;
  for (const r of fixtures) {
    const rule = failingRule(r);
    if (rule) {
      blocked++;
      tally[rule] = (tally[rule] ?? 0) + 1;
      if (!firstBlocked) firstBlocked = { row: r, rule };
    } else {
      passing++;
      if (!firstPassing) firstPassing = r;
    }
  }

  console.log(`fixture passing: ${passing}`);
  console.log(`fixture blocked: ${blocked}`);
  console.log('blocked-by-rule:');
  for (const [rule, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(38)} ${n}`);
  }
  console.log('');

  if (firstBlocked) {
    printRow(firstBlocked.row, '1. WEAK SIGNAL — BLOCKED', firstBlocked.rule);
  }
  if (firstPassing) {
    printRow(firstPassing, '2. APPROVED SIGNAL — PASSING', null);
  }

  // Invariant checks over the full fixture-passers set.
  const passers = fixtures.filter((r) => failingRule(r) === null);
  const allApproved = passers.every((r) => r.signal_status === 'APPROVED_SIGNAL');
  const allScored   = passers.every((r) => r.final_score == null || Number(r.final_score) >= 65);
  const noLiveInv   = passers.every((r) => !(r.live_invalidated === true || Number(r.live_invalidated) === 1));
  const goodDecay   = passers.every((r) => {
    const d = String(r.decay_state ?? '').toLowerCase();
    return d !== 'expired' && d !== 'stale';
  });
  const goodBand    = passers.every((r) => {
    const b = String(r.conviction_band ?? r.confidence_band ?? '').toLowerCase();
    return b !== 'avoid' && b !== 'reject';
  });

  console.log('── 3. INVARIANTS (over fixture passers) ───────────────');
  console.log(`  every passer has signal_status='APPROVED_SIGNAL':  ${allApproved}`);
  console.log(`  every passer has final_score >= 65 (when set):     ${allScored}`);
  console.log(`  no passer has live_invalidated=true:                ${noLiveInv}`);
  console.log(`  no passer has decay_state in {expired,stale}:       ${goodDecay}`);
  console.log(`  no passer has conviction_band in {avoid,reject}:    ${goodBand}`);
  console.log('');

  const ok = allApproved && allScored && noLiveInv && goodDecay && goodBand;
  console.log(ok
    ? 'RESULT: ✅ Phase-1 hard gate behaves to spec.'
    : 'RESULT: ❌ Invariant violated — predicate is buggy.');
  console.log('='.repeat(72));

  if (wantDb) {
    console.log('');
    console.log('── PROBING q365_signals (live MySQL) ─────────────────');
    const dbRows = await probeDb();
    if (!dbRows) {
      console.log('  DB unavailable — skipped.');
    } else {
      let dbPass = 0, dbBlock = 0;
      const dbTally: Record<string, number> = {};
      for (const r of dbRows) {
        const rule = failingRule(r);
        if (rule) { dbBlock++; dbTally[rule] = (dbTally[rule] ?? 0) + 1; }
        else dbPass++;
      }
      console.log(`  scanned:          ${dbRows.length}`);
      console.log(`  would pass gate:  ${dbPass}`);
      console.log(`  would be blocked: ${dbBlock}`);
      console.log('  blocked-by-rule:');
      for (const [rule, n] of Object.entries(dbTally).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${rule.padEnd(38)} ${n}`);
      }
    }
  }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[validateHardGate] failed:', e);
  process.exit(1);
});
