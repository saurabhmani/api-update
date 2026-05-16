/// <reference types="node" />
/**
 * scripts/testYahooScoringEngine.ts
 *
 * Exercises src/lib/scanner/yahooScoringEngine.ts:
 *   • One case per classification band
 *   • One case per hard-reject branch
 *   • A penalty-pushdown case (high score driven into VALID_BUY by penalties)
 *   • A formula-arithmetic verification (manual recompute)
 *
 * Run:  npx tsx scripts/testYahooScoringEngine.ts
 */

import {
  scoreCandidate,
  SCORING_WEIGHTS,
  type FactorScores,
  type ScoringInput,
  type ScoringResult,
} from '../src/lib/scanner/yahooScoringEngine';

const SEP = '─'.repeat(72);

function fmt(n: number, dp = 2): string {
  return Number.isFinite(n) ? n.toFixed(dp) : '—';
}

function printResult(label: string, r: ScoringResult): void {
  console.log(SEP);
  console.log(`case            : ${label}`);
  console.log(`final_score     : ${fmt(r.final_score)}  ` +
              `(pre-penalty=${fmt(r.composite_pre_penalty)}  −penalty=${fmt(r.total_penalty)})`);
  console.log(`classification  : ${r.classification}`);
  console.log(`decision        : ${r.decision}`);
  if (r.hard_rejects.length > 0) {
    console.log(`hard_rejects    : ${r.hard_rejects.join(', ')}`);
  }
  if (r.penalties.length > 0) {
    console.log(`penalties       : ` +
      r.penalties.map((p) => `${p.code}(-${p.points})`).join(', '));
  }
  console.log(`factors         : ` +
    `trend=${r.factor_scores.trend}  mom=${r.factor_scores.momentum}  ` +
    `vol=${r.factor_scores.volume}  brk=${r.factor_scores.breakout}  ` +
    `rr=${r.factor_scores.riskReward}  liq=${r.factor_scores.liquidity}  ` +
    `stab=${r.factor_scores.stability}`);
}

// ── Reusable factor presets ────────────────────────────────────────

const STRONG: FactorScores = {
  trend: 90, momentum: 85, volume: 80, breakout: 90,
  riskReward: 80, liquidity: 90, stability: 75,
};
const MID: FactorScores = {
  trend: 70, momentum: 65, volume: 65, breakout: 70,
  riskReward: 65, liquidity: 70, stability: 60,
};
const SOFT: FactorScores = {
  trend: 55, momentum: 50, volume: 50, breakout: 55,
  riskReward: 50, liquidity: 60, stability: 50,
};
const WEAK: FactorScores = {
  trend: 30, momentum: 25, volume: 30, breakout: 30,
  riskReward: 30, liquidity: 35, stability: 30,
};

const SAFE_GATES: Partial<ScoringInput> = {
  rsi14: 60,
  riskReward: 2.0,
  liquidityScore: 70,
  price: 1000,
  stopLoss: 950,
  isStale: false,
  isInvalidated: false,
  gapPct: 0.5,
  gapVolumeMult: 1.0,
};

function run(label: string, input: ScoringInput): ScoringResult {
  const r = scoreCandidate(input);
  printResult(label, r);
  return r;
}

// ── Tests ──────────────────────────────────────────────────────────

console.log('weights:', SCORING_WEIGHTS);

// Band cases
run('band: HIGH_CONVICTION_BUY (strong factors)',
    { factors: STRONG, ...SAFE_GATES });
run('band: VALID_BUY (mid factors)',
    { factors: MID, ...SAFE_GATES });
run('band: WATCHLIST (soft factors → NOT shown in main)',
    { factors: SOFT, ...SAFE_GATES });
run('band: REJECT (weak factors)',
    { factors: WEAK, ...SAFE_GATES });

// Hard rejects (each forces REJECT despite strong factors)
run('hard: rsi14 = 85  (RSI overbought extreme)',
    { factors: STRONG, ...SAFE_GATES, rsi14: 85 });
run('hard: riskReward = 1.2  (R:R below 1.5)',
    { factors: STRONG, ...SAFE_GATES, riskReward: 1.2 });
run('hard: liquidityScore = 35  (liq below 40)',
    { factors: STRONG, ...SAFE_GATES, liquidityScore: 35 });
run('hard: price (940) <= stopLoss (950)  (stop violated)',
    { factors: STRONG, ...SAFE_GATES, price: 940, stopLoss: 950 });
run('hard: isStale=true',
    { factors: STRONG, ...SAFE_GATES, isStale: true });
run('hard: isInvalidated=true',
    { factors: STRONG, ...SAFE_GATES, isInvalidated: true });
run('hard: gap +22% with vol mult 1.0  (extreme gap unconfirmed)',
    { factors: STRONG, ...SAFE_GATES, gapPct: 22, gapVolumeMult: 1.0 });
run('hard: gap +22% with vol mult 2.0  (volume confirms — NOT a hard reject)',
    { factors: STRONG, ...SAFE_GATES, gapPct: 22, gapVolumeMult: 2.0 });

// Multiple hard rejects fire together
run('hard: stacked (rsi=82 AND rr=1.0 AND stale)',
    { factors: STRONG, ...SAFE_GATES, rsi14: 82, riskReward: 1.0, isStale: true });

// Penalty pushdown (HIGH_CONVICTION composite, penalties drag to VALID_BUY)
run('penalty pushdown: strong factors but −12 pts',
    {
      factors: STRONG,
      ...SAFE_GATES,
      penalties: [
        { code: 'sector_concentration', points: 5,  reason: 'sector cap exceeded' },
        { code: 'stale_macro_context',  points: 4,  reason: 'macro snapshot >12h old' },
        { code: 'recent_winner_repeat', points: 3,  reason: 'symbol traded within 3 sessions' },
      ],
    });

// Formula arithmetic check (recompute by hand and compare)
const verify = scoreCandidate({ factors: STRONG, ...SAFE_GATES });
const expected =
  STRONG.trend      * 0.20 +
  STRONG.momentum   * 0.15 +
  STRONG.volume     * 0.15 +
  STRONG.breakout   * 0.20 +
  STRONG.riskReward * 0.15 +
  STRONG.liquidity  * 0.10 +
  STRONG.stability  * 0.05;
console.log(SEP);
console.log(`formula check   : engine=${fmt(verify.final_score)}  ` +
            `manual=${fmt(expected)}  ` +
            `match=${Math.abs(verify.final_score - expected) < 1e-9}`);
console.log(SEP);
