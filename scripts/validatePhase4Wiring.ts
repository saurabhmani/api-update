/**
 * scripts/validatePhase4Wiring.ts
 *
 * Phase-4 end-to-end validation. Runs the runPhase4Scoring adapter
 * (the single source of truth used by both generatePhase3Signals and
 * analyzeInstrument) across a realistic input matrix and:
 *
 *   1. dumps a sample signal-shaped object showing final_score +
 *      classification + the 8 factor_scores
 *   2. asserts EVERY produced signal carries a classification
 *      (the spec's "no signal proceeds without classification" rule)
 *   3. confirms upstream-status overrides flow through to the
 *      classification (rejected rows stay rejected)
 *
 * Run:
 *   npx tsx scripts/validatePhase4Wiring.ts
 */
import { runPhase4Scoring } from '../src/lib/signal-engine/scoring/phase4FactorAdapter';

// Mirror the real ExecutableSignal/Signal shape — identical fields
// across live and batch outputs is the spec invariant.
interface SampleSignal {
  symbol:        string;
  direction:     'BUY' | 'SELL' | 'HOLD';
  signal_status: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';
  confidence:    number;
  risk_score:    number;
  risk_reward:   number;
  entry_price:   number;
  stop_loss:     number;
  target1:       number;
  // ── Phase-4 scoring (mandatory) ─────────────────────────────
  final_score:    number;
  classification: string;
  factor_scores: {
    strategy_quality:     number;
    trend_alignment:      number;
    momentum:             number;
    volume_confirmation:  number;
    risk_reward:          number;
    liquidity:            number;
    market_regime:        number;
    portfolio_fit:        number;
  };
}

function makeSampleSignal(opts: {
  symbol: string;
  direction: 'BUY' | 'SELL';
  upstream: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';
  conf: number;
  trend: number;
  momentum: number;
  volume: number;
  liquidity: number | null;
  regime: number;
  fit: number;
  rr: number;
  volRatio: number;
  atrPct: number;
  manipulation: number | null;
  ageBars: number;
}): SampleSignal {
  const phase4 = runPhase4Scoring({
    strategyQuality:    opts.conf,
    trendAlignment:     opts.trend,
    momentum:           opts.momentum,
    volumeConfirmation: opts.volume,
    liquidity:          opts.liquidity,
    marketRegime:       opts.regime,
    portfolioFit:       opts.fit,
    riskRewardRatio:    opts.rr,
    volumeVs20dAvg:     opts.volRatio,
    atrPct:             opts.atrPct,
    manipulationScore:  opts.manipulation,
    ageBars:            opts.ageBars,
    upstreamStatus:     opts.upstream,
  });
  return {
    symbol:        opts.symbol,
    direction:     opts.direction,
    signal_status: opts.upstream,
    confidence:    opts.conf,
    risk_score:    100 - opts.conf,         // illustrative
    risk_reward:   opts.rr,
    entry_price:   1500,
    stop_loss:     opts.direction === 'BUY' ? 1460 : 1540,
    target1:       opts.direction === 'BUY' ? 1580 : 1420,
    final_score:    phase4.final_score,
    classification: phase4.classification,
    factor_scores:  phase4.factor_scores,
  };
}

const cases: SampleSignal[] = [
  makeSampleSignal({
    symbol: 'TCS',  direction: 'BUY',  upstream: 'APPROVED_SIGNAL',
    conf: 88, trend: 90, momentum: 85, volume: 88, liquidity: null,
    regime: 85, fit: 80, rr: 2.6, volRatio: 1.8, atrPct: 1.4,
    manipulation: 0, ageBars: 0,
  }),
  makeSampleSignal({
    symbol: 'INFY', direction: 'BUY',  upstream: 'APPROVED_SIGNAL',
    conf: 75, trend: 78, momentum: 70, volume: 72, liquidity: null,
    regime: 75, fit: 70, rr: 2.0, volRatio: 1.4, atrPct: 1.8,
    manipulation: 5, ageBars: 0,
  }),
  makeSampleSignal({
    symbol: 'HDFCBANK', direction: 'SELL', upstream: 'APPROVED_SIGNAL',
    conf: 68, trend: 70, momentum: 65, volume: 70, liquidity: null,
    regime: 60, fit: 65, rr: 1.7, volRatio: 1.1, atrPct: 2.5,
    manipulation: 0, ageBars: 0,
  }),
  makeSampleSignal({
    symbol: 'WEAK',  direction: 'BUY', upstream: 'APPROVED_SIGNAL',
    conf: 50, trend: 45, momentum: 50, volume: 50, liquidity: null,
    regime: 40, fit: 45, rr: 1.4, volRatio: 0.9, atrPct: 4.5,
    manipulation: 35, ageBars: 6,
  }),
  // Upstream NO_TRADE — must override classification
  makeSampleSignal({
    symbol: 'REJ',   direction: 'BUY', upstream: 'NO_TRADE',
    conf: 80, trend: 80, momentum: 80, volume: 80, liquidity: null,
    regime: 80, fit: 80, rr: 2.5, volRatio: 1.5, atrPct: 1.5,
    manipulation: 0, ageBars: 0,
  }),
  // Upstream DEVELOPING_SETUP — must override classification
  makeSampleSignal({
    symbol: 'DEV',   direction: 'BUY', upstream: 'DEVELOPING_SETUP',
    conf: 78, trend: 75, momentum: 70, volume: 70, liquidity: null,
    regime: 70, fit: 70, rr: 2.0, volRatio: 1.3, atrPct: 1.6,
    manipulation: 0, ageBars: 0,
  }),
];

// ── 1. Print sample signal ──────────────────────────────────────
console.log('='.repeat(72));
console.log('PHASE-4 WIRING — SAMPLE SIGNAL OBJECT');
console.log('='.repeat(72));
const sample = cases[0];
console.log(JSON.stringify(sample, null, 2));
console.log('');

// ── 2. Per-case summary ─────────────────────────────────────────
console.log('── Per-case summary ────────────────────────────────────');
console.log('symbol      status              dir   final  classification');
for (const c of cases) {
  console.log(
    `${c.symbol.padEnd(11)} ${c.signal_status.padEnd(19)} ${c.direction.padEnd(5)} ` +
    `${c.final_score.toString().padStart(5)}  ${c.classification}`,
  );
}
console.log('');

// ── 3. Invariants ───────────────────────────────────────────────
const ALLOWED = new Set([
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
  'DEVELOPING_SETUP',
  'WATCHLIST_ONLY',
  'NO_TRADE',
]);

let allClassified  = true;
let allInRange     = true;
let allFactorsSet  = true;
let upstreamHonored = true;
for (const c of cases) {
  if (!c.classification || !ALLOWED.has(c.classification)) {
    allClassified = false;
    console.log(`✗ ${c.symbol}: missing/invalid classification: ${c.classification}`);
  }
  if (!Number.isFinite(c.final_score) || c.final_score < 0 || c.final_score > 100) {
    allInRange = false;
    console.log(`✗ ${c.symbol}: final_score out of [0, 100]: ${c.final_score}`);
  }
  for (const [k, v] of Object.entries(c.factor_scores)) {
    if (!Number.isFinite(v)) {
      allFactorsSet = false;
      console.log(`✗ ${c.symbol}: factor ${k} not a finite number: ${v}`);
    }
  }
  if (c.signal_status === 'NO_TRADE'         && c.classification !== 'NO_TRADE')         upstreamHonored = false;
  if (c.signal_status === 'DEVELOPING_SETUP' && c.classification !== 'DEVELOPING_SETUP') upstreamHonored = false;
}

console.log('── Invariants ──────────────────────────────────────────');
console.log(`  every signal has a classification:                  ${allClassified}`);
console.log(`  every classification is in the allowed 6-band set:  ${allClassified}`);
console.log(`  every final_score is in [0, 100]:                   ${allInRange}`);
console.log(`  every factor_scores entry is a finite number:        ${allFactorsSet}`);
console.log(`  upstream NO_TRADE / DEVELOPING_SETUP override fires: ${upstreamHonored}`);
console.log('');

const ok = allClassified && allInRange && allFactorsSet && upstreamHonored;
console.log('='.repeat(72));
console.log(ok
  ? 'RESULT: ✅ Phase-4 wiring honours the spec — no signal proceeds without classification.'
  : 'RESULT: ❌ At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
