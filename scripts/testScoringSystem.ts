/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════
//  Scoring / Classification System Test Harness
//
//  Generates 8 synthetic candidate signals that span the full
//  quality spectrum (from clear HIGH_CONVICTION down to structural
//  NO_TRADE). Runs each through the scoring engine, filters to the
//  signals-table gate (VALID_SIGNAL or better), and displays the
//  top 5 that remain alongside the rejected set for verification.
//
//  Run: npx tsx scripts/testScoringSystem.ts
// ════════════════════════════════════════════════════════════════

import {
  computeFinalScore,
  type ScoringInput,
  type ScoringResult,
  type ClassificationBand,
} from '../src/lib/signal-engine/scoring/scoringEngine';
import type { StrategyName } from '../src/lib/signal-engine/types/signalEngine.types';

interface Candidate {
  symbol:     string;
  strategy:   StrategyName;
  scoring:    ScoringInput;
}

// ── 8 synthetic candidates across the quality spectrum ─────────
const CANDIDATES: Candidate[] = [
  // Clear HIGH_CONVICTION: every dimension strong.
  { symbol: 'RELIANCE',   strategy: 'bullish_breakout',
    scoring: { confidenceScore: 88, riskScore: 22, riskReward: 2.8,
               portfolioFit: 85, regimeAlignment: 80, freshnessScore: 95 } },

  // HIGH_CONVICTION borderline — meets all three gates.
  { symbol: 'TCS',        strategy: 'bullish_pullback',
    scoring: { confidenceScore: 76, riskScore: 30, riskReward: 2.1,
               portfolioFit: 78, regimeAlignment: 72, freshnessScore: 88 } },

  // VALID_SIGNAL — good but confidence shy of 70 blocks high-conviction.
  { symbol: 'HDFCBANK',   strategy: 'momentum_continuation',
    scoring: { confidenceScore: 68, riskScore: 35, riskReward: 1.8,
               portfolioFit: 70, regimeAlignment: 65, freshnessScore: 82 } },

  // VALID_SIGNAL — mid-band, meets the 50 floor.
  { symbol: 'INFY',       strategy: 'bullish_breakout',
    scoring: { confidenceScore: 64, riskScore: 42, riskReward: 1.6,
               portfolioFit: 62, regimeAlignment: 58, freshnessScore: 75 } },

  // VALID_SIGNAL — bearish side, still clears the gate.
  { symbol: 'COALINDIA',  strategy: 'bearish_breakdown',
    scoring: { confidenceScore: 66, riskScore: 38, riskReward: 1.9,
               portfolioFit: 68, regimeAlignment: 55, freshnessScore: 80 } },

  // DEVELOPING_SETUP — final score lands in 30-50 band.
  { symbol: 'WIPRO',      strategy: 'bullish_pullback',
    scoring: { confidenceScore: 55, riskScore: 58, riskReward: 1.3,
               portfolioFit: 45, regimeAlignment: 40, freshnessScore: 60 } },

  // NO_TRADE — R:R below 1.0 floor.
  { symbol: 'IDEA',       strategy: 'mean_reversion_bounce',
    scoring: { confidenceScore: 62, riskScore: 55, riskReward: 0.8,
               portfolioFit: 50, regimeAlignment: 45, freshnessScore: 70 } },

  // NO_TRADE — confidence below 50 floor.
  { symbol: 'YESBANK',    strategy: 'bullish_breakout',
    scoring: { confidenceScore: 42, riskScore: 68, riskReward: 1.4,
               portfolioFit: 40, regimeAlignment: 35, freshnessScore: 55 } },
];

interface ScoredRow {
  symbol:         string;
  strategy:       StrategyName;
  final_score:    number;
  classification: ClassificationBand;
  risk_score:     number;
}

function scoreAll(rows: Candidate[]): Array<{ cand: Candidate; result: ScoringResult }> {
  return rows.map((cand) => ({ cand, result: computeFinalScore(cand.scoring) }));
}

function isHighQuality(band: ClassificationBand): boolean {
  // Signals-table gate: HIGH_CONVICTION or VALID_SIGNAL.
  return band === 'HIGH_CONVICTION' || band === 'VALID_SIGNAL';
}

function formatTable(rows: ScoredRow[]): string {
  const header = ['#', 'SYMBOL', 'STRATEGY', 'FINAL_SCORE', 'CLASSIFICATION', 'RISK_SCORE'];
  const data   = rows.map((r, i) => [
    String(i + 1),
    r.symbol,
    r.strategy,
    r.final_score.toFixed(1),
    r.classification,
    r.risk_score.toFixed(0),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const line = (cols: string[]) => cols.map((c, i) => pad(c, widths[i])).join('  ');
  const sep  = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(header), sep, ...data.map(line)].join('\n');
}

function main() {
  const scored = scoreAll(CANDIDATES);

  // Filter to signals-table gate and take top 5 by final score.
  const passed = scored
    .filter(({ result }) => isHighQuality(result.classification))
    .sort((a, b) => b.result.finalScore - a.result.finalScore)
    .slice(0, 5);

  const rejected = scored.filter(({ result }) => !isHighQuality(result.classification));

  const topRows: ScoredRow[] = passed.map(({ cand, result }) => ({
    symbol:         cand.symbol,
    strategy:       cand.strategy,
    final_score:    result.finalScore,
    classification: result.classification,
    risk_score:     cand.scoring.riskScore,
  }));

  console.log('\n━━━ TOP 5 HIGH-QUALITY SIGNALS ━━━\n');
  console.log(formatTable(topRows));

  console.log('\n━━━ REJECTED (weak) SIGNALS ━━━\n');
  const rejRows: ScoredRow[] = rejected.map(({ cand, result }) => ({
    symbol:         cand.symbol,
    strategy:       cand.strategy,
    final_score:    result.finalScore,
    classification: result.classification,
    risk_score:     cand.scoring.riskScore,
  }));
  console.log(formatTable(rejRows));

  // ── Verification assertions ───────────────────────────────────
  const errors: string[] = [];

  // 1. No weak signals in the shown set.
  for (const r of topRows) {
    if (!isHighQuality(r.classification)) {
      errors.push(`FAIL: "${r.symbol}" shown despite classification=${r.classification}`);
    }
  }
  // 2. Every shown row clears final_score ≥ 50.
  for (const r of topRows) {
    if (r.final_score < 50) {
      errors.push(`FAIL: "${r.symbol}" shown with final_score=${r.final_score} < 50`);
    }
  }
  // 3. Every rejected row is either NO_TRADE or DEVELOPING_SETUP.
  for (const r of rejRows) {
    if (isHighQuality(r.classification)) {
      errors.push(`FAIL: "${r.symbol}" rejected despite classification=${r.classification}`);
    }
  }
  // 4. At least the clearly weak ones (R:R<1, confidence<50) are out.
  const weakSymbols = ['IDEA', 'YESBANK', 'WIPRO'];
  for (const w of weakSymbols) {
    if (topRows.find((r) => r.symbol === w)) {
      errors.push(`FAIL: weak signal "${w}" leaked into shown set`);
    }
  }

  console.log('\n━━━ VERIFICATION ━━━\n');
  console.log(`Candidates in:  ${CANDIDATES.length}`);
  console.log(`Shown:          ${topRows.length} (HIGH_CONVICTION + VALID_SIGNAL)`);
  console.log(`Rejected:       ${rejRows.length} (DEVELOPING_SETUP + NO_TRADE)`);
  console.log(`Min shown score: ${Math.min(...topRows.map((r) => r.final_score)).toFixed(1)}`);
  console.log(`Max rejected score: ${Math.max(...rejRows.map((r) => r.final_score)).toFixed(1)}`);

  if (errors.length === 0) {
    console.log('\n✓ All assertions passed — weak signals filtered, only high-quality signals remain.');
    process.exit(0);
  } else {
    console.log('\n✗ Assertion failures:');
    errors.forEach((e) => console.log('  ' + e));
    process.exit(1);
  }
}

main();
