/**
 * scripts/diagnoseInstitutionalFunnel.ts
 *
 * Spec INSTITUTIONAL §L (audit) — stage-by-stage drop accounting for
 * the institutional signal pipeline. Answers the question:
 *
 *   "Why is finalRows=0?  Which gate is dropping every row?"
 *
 * The script reads BOTH source tables:
 *   • q365_confirmed_signal_snapshots (the institutional layer)
 *   • q365_signals                    (the scanner / pre-promotion layer)
 *
 * For each row, walks every gate the response pipeline would apply:
 *
 *    raw_in_window
 *    → status=ACTIVE
 *    → not invalidated
 *    → strategy / direction present
 *    → confidence floor
 *    → final_score floor
 *    → rr floor
 *    → stress_survival floor
 *    → stable=true
 *    → execution_allowed
 *    → classification ∈ institutional whitelist
 *    → fresh enough (market-aware: 6h open / 24h closed)
 *    → finalRows
 *
 * Prints:
 *   1. Stage counts (total at each gate).
 *   2. Per-row rejection { symbol, classification, confidence,
 *      final_score, stress, stable, execution_allowed,
 *      rejection_reason, filtered_at_stage }.
 *   3. Bottleneck stage (the gate that dropped the most rows).
 *   4. Suggested floor adjustments to hit a 5–20 row target.
 *
 * Usage:
 *   npx tsx scripts/diagnoseInstitutionalFunnel.ts                 # last 24h
 *   npx tsx scripts/diagnoseInstitutionalFunnel.ts --hours 48
 *   npx tsx scripts/diagnoseInstitutionalFunnel.ts --table snapshots
 *   npx tsx scripts/diagnoseInstitutionalFunnel.ts --table q365_signals
 *   npx tsx scripts/diagnoseInstitutionalFunnel.ts --rejects 50    # show 50 rejection rows
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { getMarketStatus } from '../src/lib/marketData/marketHours';
import { isFreshEnough }   from '../src/lib/signals/rotationPolicy';
import {
  STRICT_FINAL_FLOOR, STRICT_CONFIDENCE_FLOOR, STRICT_RR_FLOOR, STRICT_STRESS_FLOOR,
  MAIN_TABLE_DISPLAY_CLS,
}                           from '../src/lib/signals/confirmedSignalPolicy';

interface Args {
  hours:   number;
  table:   'snapshots' | 'q365_signals' | 'both';
  rejects: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get  = (k: string, d: string): string => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? d) : d;
  };
  const hours = Math.max(1, Math.min(168, Number(get('--hours', '24')) || 24));
  const tRaw  = get('--table', 'both').toLowerCase();
  const table: Args['table'] = tRaw === 'snapshots' ? 'snapshots'
                              : tRaw === 'q365_signals' ? 'q365_signals'
                              : 'both';
  const rejects = Math.max(0, Math.min(500, Number(get('--rejects', '20')) || 20));
  return { hours, table, rejects };
}

interface RowProbe {
  symbol:                 string;
  direction:              string;
  classification:         string;
  raw_classification:     string;
  signal_status:          string;
  status:                 string;
  invalidation_reason:    string | null;
  live_valid:             number | boolean | null;
  execution_allowed:      boolean | null;
  stable:                 number | boolean | null;
  confidence:             number | null;
  final_score:            number | null;
  rr:                     number | null;
  stress:                 number | null;
  age_minutes:            number | null;
  source_table:           'q365_confirmed_signal_snapshots' | 'q365_signals';
}

const STAGES = [
  'raw_in_window',
  'status_active',
  'not_invalidated',
  'has_direction',
  'confidence_floor',
  'final_score_floor',
  'rr_floor',
  'stress_floor',
  'stable',
  'execution_allowed',
  'classification_whitelist',
  'fresh_enough',
  'final',
] as const;
type Stage = typeof STAGES[number];

interface StageCount {
  in:       number;
  passed:   number;
  dropped:  number;
}

function makeFunnel(): Map<Stage, StageCount> {
  const m = new Map<Stage, StageCount>();
  for (const s of STAGES) m.set(s, { in: 0, passed: 0, dropped: 0 });
  return m;
}

interface Reject {
  symbol:           string;
  filtered_at_stage: Stage;
  reason:           string;
  classification:   string;
  confidence:       number | null;
  final_score:      number | null;
  stress:           number | null;
  stable:           number | boolean | null;
  execution_allowed: boolean | null;
  source_table:     string;
}

function evaluateRow(
  r: RowProbe,
  marketOpen: boolean,
  funnel: Map<Stage, StageCount>,
  rejects: Reject[],
): boolean {
  const fail = (stage: Stage, reason: string): false => {
    funnel.get(stage)!.dropped += 1;
    rejects.push({
      symbol:           r.symbol,
      filtered_at_stage: stage,
      reason,
      classification:   r.classification,
      confidence:       r.confidence,
      final_score:      r.final_score,
      stress:           r.stress,
      stable:           r.stable,
      execution_allowed: r.execution_allowed,
      source_table:     r.source_table,
    });
    return false;
  };
  const pass = (stage: Stage): void => { funnel.get(stage)!.passed += 1; };
  for (const s of STAGES) funnel.get(s)!.in += 1;

  pass('raw_in_window');
  if (r.status && !['ACTIVE', 'active', ''].includes(r.status)) {
    return fail('status_active', `status=${r.status}`);
  }
  pass('status_active');
  if (r.invalidation_reason) {
    return fail('not_invalidated', r.invalidation_reason);
  }
  pass('not_invalidated');
  if (!r.direction || !['BUY', 'SELL'].includes(r.direction.toUpperCase())) {
    return fail('has_direction', `direction=${r.direction}`);
  }
  pass('has_direction');
  if (r.confidence == null || r.confidence < STRICT_CONFIDENCE_FLOOR) {
    return fail('confidence_floor', `${r.confidence} < ${STRICT_CONFIDENCE_FLOOR}`);
  }
  pass('confidence_floor');
  if (r.final_score == null || r.final_score < STRICT_FINAL_FLOOR) {
    return fail('final_score_floor', `${r.final_score} < ${STRICT_FINAL_FLOOR}`);
  }
  pass('final_score_floor');
  if (r.rr == null || r.rr < STRICT_RR_FLOOR) {
    return fail('rr_floor', `${r.rr} < ${STRICT_RR_FLOOR}`);
  }
  pass('rr_floor');
  if (STRICT_STRESS_FLOOR > 0 && r.stress != null && r.stress < STRICT_STRESS_FLOOR) {
    return fail('stress_floor', `${r.stress} < ${STRICT_STRESS_FLOOR}`);
  }
  pass('stress_floor');
  // stable: snapshots column populated at promotion; q365_signals never has it.
  // Treat null as soft-pass for q365_signals (the scanner table doesn't run
  // the maturity tracker), but require true on confirmed snapshots.
  const stableTrue = r.stable === true || r.stable === 1;
  if (r.source_table === 'q365_confirmed_signal_snapshots' && !stableTrue) {
    return fail('stable', `stable=${r.stable}`);
  }
  pass('stable');
  if (r.execution_allowed === false) {
    return fail('execution_allowed', 'execution_allowed=false');
  }
  pass('execution_allowed');
  const cls    = String(r.classification ?? '').toUpperCase();
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  // Reject NO_TRADE / WATCHLIST / DEVELOPING_SETUP at the raw level
  // (NO-TRADE-PRECEDENCE).
  const NEVER_SHIP = new Set(['NO_TRADE', 'WATCHLIST', 'WATCHLIST_ONLY', 'DEVELOPING_SETUP', 'REJECTED']);
  if (rawCls && NEVER_SHIP.has(rawCls)) {
    return fail('classification_whitelist', `raw_classification=${rawCls}`);
  }
  if (cls && NEVER_SHIP.has(cls)) {
    return fail('classification_whitelist', `classification=${cls}`);
  }
  if (cls && !MAIN_TABLE_DISPLAY_CLS.has(cls)) {
    return fail('classification_whitelist', `classification=${cls} not in {${[...MAIN_TABLE_DISPLAY_CLS].join(', ')}}`);
  }
  pass('classification_whitelist');
  // Freshness — treat confirmed_at as the timestamp source. We pass the
  // age via a synthetic row to isFreshEnough.
  const fresh = isFreshEnough(
    { confirmed_at: new Date(Date.now() - (r.age_minutes ?? 0) * 60_000).toISOString() },
    { marketOpen },
  );
  if (!fresh) {
    const cap = marketOpen ? 360 : 1440;
    return fail('fresh_enough', `age=${r.age_minutes}min > ${cap}min cap (marketOpen=${marketOpen})`);
  }
  pass('fresh_enough');
  pass('final');
  return true;
}

async function readSnapshots(hours: number): Promise<RowProbe[]> {
  const sql = `
    SELECT s.symbol, s.direction, s.classification,
           s.classification AS raw_classification,
           'APPROVED_SIGNAL' AS signal_status,
           s.status, s.invalidation_reason,
           s.live_valid,
           s.confidence_score, s.final_score, s.rr_ratio, s.stress_survival_score,
           s.stability_passed,
           s.confirmed_at, s.valid_until
    FROM q365_confirmed_signal_snapshots s
    WHERE s.confirmed_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    ORDER BY s.confirmed_at DESC
    LIMIT 500
  `;
  try {
    const { rows } = await db.query<any>(sql, [hours]);
    return (rows as any[]).map((r) => ({
      symbol:               String(r.symbol ?? ''),
      direction:            String(r.direction ?? ''),
      classification:       String(r.classification ?? ''),
      raw_classification:   String(r.raw_classification ?? ''),
      signal_status:        'APPROVED_SIGNAL',
      status:               String(r.status ?? ''),
      invalidation_reason:  r.invalidation_reason ?? null,
      live_valid:           r.live_valid,
      execution_allowed:    r.status === 'ACTIVE' && !r.invalidation_reason
                              && (r.valid_until == null || new Date(r.valid_until).getTime() > Date.now()),
      stable:               r.stability_passed,
      confidence:           r.confidence_score == null ? null : Number(r.confidence_score),
      final_score:          r.final_score == null      ? null : Number(r.final_score),
      rr:                   r.rr_ratio == null         ? null : Number(r.rr_ratio),
      stress:               r.stress_survival_score == null ? null : Number(r.stress_survival_score),
      age_minutes:          r.confirmed_at ? Math.max(0, Math.round((Date.now() - new Date(r.confirmed_at).getTime()) / 60_000)) : null,
      source_table:         'q365_confirmed_signal_snapshots',
    }));
  } catch (err: any) {
    console.warn('[diagnose] snapshots query failed:', err?.message);
    return [];
  }
}

async function readQ365Signals(hours: number): Promise<RowProbe[]> {
  const sql = `
    SELECT s.symbol, s.direction, s.classification,
           s.classification AS raw_classification,
           s.signal_status, s.status, s.invalidation_reason,
           s.live_valid,
           s.confidence_score, s.final_score, s.risk_reward, s.stress_survival_score,
           NULL AS stability_passed,
           s.generated_at, s.expires_at
    FROM q365_signals s
    WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
    ORDER BY s.generated_at DESC
    LIMIT 1000
  `;
  try {
    const { rows } = await db.query<any>(sql, [hours]);
    return (rows as any[]).map((r) => ({
      symbol:               String(r.symbol ?? ''),
      direction:            String(r.direction ?? ''),
      classification:       String(r.classification ?? ''),
      raw_classification:   String(r.raw_classification ?? ''),
      signal_status:        String(r.signal_status ?? ''),
      status:               String(r.status ?? ''),
      invalidation_reason:  r.invalidation_reason ?? null,
      live_valid:           r.live_valid,
      execution_allowed:    String(r.status ?? '').toLowerCase() === 'active' && !r.invalidation_reason
                              && (r.expires_at == null || new Date(r.expires_at).getTime() > Date.now()),
      stable:               null,
      confidence:           r.confidence_score == null ? null : Number(r.confidence_score),
      final_score:          r.final_score == null      ? null : Number(r.final_score),
      rr:                   r.risk_reward == null      ? null : Number(r.risk_reward),
      stress:               r.stress_survival_score == null ? null : Number(r.stress_survival_score),
      age_minutes:          r.generated_at ? Math.max(0, Math.round((Date.now() - new Date(r.generated_at).getTime()) / 60_000)) : null,
      source_table:         'q365_signals',
    }));
  } catch (err: any) {
    console.warn('[diagnose] q365_signals query failed:', err?.message);
    return [];
  }
}

function pad(s: string | number, n: number, right = false): string {
  const x = String(s);
  return right ? x.padStart(n) : x.padEnd(n);
}

async function main(): Promise<void> {
  const args   = parseArgs();
  const market = getMarketStatus();
  const marketOpen = market.isOpen;
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  INSTITUTIONAL FUNNEL DIAGNOSTIC — ${args.table.toUpperCase()} window=${args.hours}h`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  market: ${marketOpen ? 'OPEN' : 'CLOSED'}   floors: conf≥${STRICT_CONFIDENCE_FLOOR}  final≥${STRICT_FINAL_FLOOR}  rr≥${STRICT_RR_FLOOR}  stress≥${STRICT_STRESS_FLOOR}`);
  console.log(`  whitelist: {${[...MAIN_TABLE_DISPLAY_CLS].join(', ')}}`);
  console.log('');

  const sources: RowProbe[] = [];
  if (args.table === 'snapshots' || args.table === 'both') {
    const s = await readSnapshots(args.hours);
    console.log(`  loaded ${s.length} rows from q365_confirmed_signal_snapshots`);
    sources.push(...s);
  }
  if (args.table === 'q365_signals' || args.table === 'both') {
    const q = await readQ365Signals(args.hours);
    console.log(`  loaded ${q.length} rows from q365_signals`);
    sources.push(...q);
  }
  console.log('');

  if (sources.length === 0) {
    console.log('  ⚠ Both source tables are empty — the scanner pipeline has not produced any rows.');
    console.log('     This is a SCANNER / PIPELINE issue, not a filter issue. Check:');
    console.log('       • POST /api/run-signal-engine completed?');
    console.log('       • last_pipeline_run timestamp on /api/signals?action=all');
    console.log('       • [PIPELINE] log lines in PM2 / docker stdout');
    process.exit(2);
  }

  const funnel  = makeFunnel();
  const rejects: Reject[] = [];
  const survivors: RowProbe[] = [];
  for (const r of sources) {
    if (evaluateRow(r, marketOpen, funnel, rejects)) survivors.push(r);
  }

  // Stage table.
  console.log('  STAGE FUNNEL');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('   stage                          in       passed   dropped  drop_pct');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  let bottleneckStage: Stage = 'final';
  let bottleneckDropped = -1;
  for (const s of STAGES) {
    const c = funnel.get(s)!;
    const pct = c.in > 0 ? Math.round((c.dropped / c.in) * 100) : 0;
    console.log(`   ${pad(s, 30)} ${pad(c.in, 7, true)}  ${pad(c.passed, 7, true)}  ${pad(c.dropped, 7, true)}  ${pad(pct + '%', 7, true)}`);
    if (s !== 'raw_in_window' && c.dropped > bottleneckDropped) {
      bottleneckDropped = c.dropped;
      bottleneckStage   = s;
    }
  }
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log(`   FINAL ROWS THAT PASSED ALL GATES: ${survivors.length}`);
  console.log('');

  // Bottleneck.
  console.log(`  ⮕ BOTTLENECK STAGE: ${bottleneckStage} (dropped ${bottleneckDropped} rows)`);
  console.log('');

  // Rejection sample.
  console.log(`  REJECTED ROWS (sample of ${Math.min(args.rejects, rejects.length)} / ${rejects.length})`);
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  console.log('   symbol           cls                          conf  final  stress stable exec  stage                  reason');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  for (const r of rejects.slice(0, args.rejects)) {
    console.log(
      `   ${pad(r.symbol, 16)} ${pad(r.classification.slice(0, 28), 28)} ` +
      `${pad(r.confidence ?? '—', 5, true)} ` +
      `${pad(r.final_score ?? '—', 5, true)} ` +
      `${pad(r.stress ?? '—', 6, true)} ` +
      `${pad(String(r.stable ?? '—'), 6, true)} ` +
      `${pad(String(r.execution_allowed ?? '—'), 5, true)} ` +
      `${pad(r.filtered_at_stage, 22)} ${r.reason}`,
    );
  }
  if (rejects.length > args.rejects) {
    console.log(`   … and ${rejects.length - args.rejects} more (run with --rejects ${rejects.length} to see all)`);
  }
  console.log('');

  // Survivors.
  console.log(`  SURVIVORS (top 20 by final_score)`);
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  if (survivors.length === 0) {
    console.log('   (none)');
  } else {
    const top = survivors
      .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
      .slice(0, 20);
    console.log('   #  symbol           dir   cls                      final  conf  rr    stress  age_min  source');
    for (let i = 0; i < top.length; i++) {
      const r = top[i];
      console.log(
        `   ${pad(i + 1, 2, true)} ${pad(r.symbol, 16)} ${pad(r.direction, 5)} ` +
        `${pad(r.classification.slice(0, 22), 22)} ` +
        `${pad(r.final_score ?? '—', 5, true)}  ${pad(r.confidence ?? '—', 4, true)}  ` +
        `${pad(r.rr ?? '—', 4, true)}  ${pad(r.stress ?? '—', 6, true)}  ` +
        `${pad(r.age_minutes ?? '—', 7, true)}  ${r.source_table === 'q365_confirmed_signal_snapshots' ? 'snap' : 'q365'}`,
      );
    }
  }
  console.log('');

  // Suggestion.
  console.log('  THRESHOLD SUGGESTION');
  console.log('  ──────────────────────────────────────────────────────────────────────────');
  const target = { lo: 5, hi: 20 };
  if (survivors.length >= target.lo && survivors.length <= target.hi) {
    console.log(`   ✓ Current floors produce ${survivors.length} signals — inside target band [${target.lo}, ${target.hi}]. No change needed.`);
  } else if (survivors.length > target.hi) {
    console.log(`   ⚠ Producing ${survivors.length} signals > ${target.hi}. Consider tightening floors:`);
    console.log(`        SIGNAL_API_STRICT_CONFIDENCE_FLOOR=${STRICT_CONFIDENCE_FLOOR + 5}`);
    console.log(`        SIGNAL_API_STRICT_FINAL_FLOOR=${STRICT_FINAL_FLOOR + 5}`);
  } else {
    console.log(`   ✗ Producing ${survivors.length} signals < ${target.lo}. Bottleneck is "${bottleneckStage}".`);
    if (bottleneckStage === 'classification_whitelist') {
      console.log(`        — The scanner is emitting non-institutional classifications. Check`);
      console.log(`          the writer that promotes q365_signals → q365_confirmed_signal_snapshots.`);
      console.log(`          Verify normalizeClassification produces INSTITUTIONAL_HIGH_CONVICTION /`);
      console.log(`          HIGH_CONVICTION / VALID_SIGNAL based on final_score.`);
    } else if (bottleneckStage === 'final_score_floor' || bottleneckStage === 'confidence_floor') {
      console.log(`        — Most rows are below the score floors. Either:`);
      console.log(`          (a) Lower the floor:  SIGNAL_API_STRICT_${bottleneckStage === 'final_score_floor' ? 'FINAL' : 'CONFIDENCE'}_FLOOR=<n>`);
      console.log(`          (b) Investigate why the scoring engine is producing low scores.`);
    } else if (bottleneckStage === 'stress_floor') {
      console.log(`        — Stress survival is the bottleneck. Lower SIGNAL_API_STRICT_STRESS_FLOOR=40,`);
      console.log(`          or SIGNAL_API_STRICT_STRESS_FLOOR=0 to disable. Also check that the Phase-7`);
      console.log(`          stress engine is being invoked.`);
    } else if (bottleneckStage === 'stable') {
      console.log(`        — Maturity tracker has not stamped stability_passed=1 on confirmed snapshots.`);
      console.log(`          Set SIGNAL_API_REQUIRE_STABLE=0 as a soft-relax, or fix the maturity worker.`);
    } else if (bottleneckStage === 'fresh_enough') {
      console.log(`        — All rows older than the freshness cap. Either:`);
      console.log(`          (a) Run the pipeline:  POST /api/run-signal-engine`);
      console.log(`          (b) Widen cap: SIGNAL_MAX_AGE_${marketOpen ? 'MIN' : 'CLOSED_MIN'}=<minutes>`);
    } else if (bottleneckStage === 'execution_allowed') {
      console.log(`        — All rows have execution_allowed=false. Check the lifecycle worker —`);
      console.log(`          rows are likely INVALIDATED / EXPIRED status without being re-promoted.`);
    } else {
      console.log(`        — Investigate "${bottleneckStage}" — see rejection sample above.`);
    }
  }
  console.log('');

  process.exit(survivors.length === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('diagnose script failed:', err);
  process.exit(2);
});
