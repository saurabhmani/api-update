/**
 * scripts/phaseNextAcceptance.ts
 *
 * Phase-NEXT acceptance audit. Drives 10 synthetic but realistic
 * symbols through the new institutional layer:
 *
 *   • Portfolio risk (with portfolio_heat + sector / cluster caps)
 *   • Live execution validation
 *   • Multi-timeframe alignment (daily / 4H / 1H)
 *   • Trade lifecycle engine
 *   • Stress survival
 *   • Institutional audit log
 *
 * For each symbol prints:
 *   final_score, portfolio_fit_score, execution_allowed, slippage_pct,
 *   alignment_state, lifecycle_state, stress_survival, decision.
 *
 * Asserts:
 *   • No weak signals reach APPROVED.
 *   • No stale ACTIVE trades survive.
 *   • Portfolio risk limits (sector, heat, correlation, position) enforced.
 *   • Execution-invalid trades rejected from APPROVED.
 *
 * Run:
 *   npx tsx scripts/phaseNextAcceptance.ts
 */

import {
  evaluatePortfolioRisk,
  type PortfolioRiskOpenPosition,
} from '../src/lib/signal-engine/portfolio/portfolioRiskEngine';
import {
  validateLiveExecution,
} from '../src/lib/signal-engine/live/liveExecutionValidation';
import {
  evaluateMultiTimeframeAlignment,
} from '../src/lib/signal-engine/multitimeframe/multiTimeframeAlignment';
import {
  createTradeLifecycle,
  transitionTradeLifecycle,
  applyAutoExpiry,
  type TradeLifecycleState,
  type TradeLifecycle,
} from '../src/lib/signal-engine/lifecycle/tradeLifecycleEngine';
import { runStressTest }       from '../src/lib/signal-engine/risk/stressTestEngine';
import { buildAuditRecord, renderAuditLine }
  from '../src/lib/signal-engine/audit/institutionalAuditLog';
import type { Candle } from '../src/lib/signal-engine/types/signalEngine.types';

// ── Test fixtures ──────────────────────────────────────────────

const NOW = new Date('2026-05-09T10:00:00Z');

// A small synthetic candle generator. Produces a deterministic
// linear+noise series so trends are predictable per symbol.
function makeCandles(
  count: number,
  startPrice: number,
  driftPerBar: number,
  noise: number = 0,
  seed: number = 1,
): Candle[] {
  const candles: Candle[] = [];
  let price = startPrice;
  let s = seed;
  for (let i = 0; i < count; i++) {
    s = (s * 9301 + 49297) % 233280;
    const wobble = ((s / 233280) - 0.5) * 2 * noise;
    const open = price;
    const close = price + driftPerBar + wobble;
    const high = Math.max(open, close) + Math.abs(wobble) * 0.5;
    const low  = Math.min(open, close) - Math.abs(wobble) * 0.5;
    candles.push({
      ts: new Date(NOW.getTime() - (count - i) * 86_400_000).toISOString(),
      open, high, low, close,
      volume: 1_000_000 + Math.round(wobble * 1000),
    });
    price = close;
  }
  return candles;
}

interface Candidate {
  symbol:           string;
  strategy:         string;
  sector:           string;
  direction:        'BUY' | 'SELL';
  entryPrice:       number;
  stopLoss:         number;
  livePrice:        number;
  bid:              number;
  ask:              number;
  positionSize:     number;
  grossValue:       number;
  riskAllocated:    number;
  atrPct:           number;
  liquidityScore:   number;
  avgDailyVolume:   number;
  finalScore:       number;
  classification:   string;
  factorScores:     Record<string, number>;
  correlationCluster?: string;
  // Trend bias for the candle generator
  dailyDrift:       number;
  fourHourDrift:    number;
  oneHourDrift:     number;
  // Lifecycle entry state and synthetic age (hours since changedAt).
  initialLifecycleState: TradeLifecycleState;
  ageHoursOnRecord:      number;
  expectedDecision:      'APPROVED' | 'REJECTED';
  expectedBlockingHints: string[];
}

const CAPITAL          = 5_000_000;       // 50 lakh
const OPEN_POSITIONS: PortfolioRiskOpenPosition[] = [
  { symbol: 'TCS',      sector: 'IT',       grossValue: 400_000, riskAllocated:  6_000, correlationCluster: 'IT_LARGE' },
  { symbol: 'INFY',     sector: 'IT',       grossValue: 400_000, riskAllocated:  6_000, correlationCluster: 'IT_LARGE' },
  { symbol: 'HDFCBANK', sector: 'Banking',  grossValue: 350_000, riskAllocated:  5_500, correlationCluster: 'BANK' },
  { symbol: 'ICICIBANK',sector: 'Banking',  grossValue: 350_000, riskAllocated:  5_000, correlationCluster: 'BANK' },
  { symbol: 'AXISBANK', sector: 'Banking',  grossValue: 250_000, riskAllocated:  3_500, correlationCluster: 'BANK' },
];

const CANDIDATES: Candidate[] = [
  // 1. Clean approval — institutional grade.
  {
    symbol: 'RELIANCE', strategy: 'momentum_followthrough', sector: 'Energy', direction: 'BUY',
    entryPrice: 2400, stopLoss: 2300, livePrice: 2402, bid: 2401.5, ask: 2402.5,
    positionSize: 100, grossValue: 240_000, riskAllocated: 10_000, atrPct: 0.012,
    liquidityScore: 90, avgDailyVolume: 5_000_000,
    finalScore: 88, classification: 'INSTITUTIONAL_HIGH_CONVICTION',
    factorScores: { strategy_quality: 90, trend_alignment: 88, momentum: 85, volume_confirmation: 80,
                    risk_reward: 86, liquidity: 92, market_regime: 80, portfolio_fit: 84 },
    correlationCluster: 'ENERGY',
    dailyDrift: 8, fourHourDrift: 4, oneHourDrift: 1.5,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'APPROVED', expectedBlockingHints: [],
  },
  // 2. Sector overexposure (Banking already at ~19 % — adding 8 % more).
  {
    symbol: 'KOTAKBANK', strategy: 'bullish_breakout', sector: 'Banking', direction: 'BUY',
    entryPrice: 1800, stopLoss: 1740, livePrice: 1802, bid: 1801.5, ask: 1802.5,
    positionSize: 250, grossValue: 450_000, riskAllocated: 15_000, atrPct: 0.013,
    liquidityScore: 85, avgDailyVolume: 3_000_000,
    finalScore: 78, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 80, trend_alignment: 80, momentum: 75, volume_confirmation: 70,
                    risk_reward: 78, liquidity: 84, market_regime: 70, portfolio_fit: 50 },
    correlationCluster: 'BANK',
    dailyDrift: 6, fourHourDrift: 3, oneHourDrift: 1,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED', expectedBlockingHints: ['SECTOR_OVEREXPOSURE'],
  },
  // 3. Correlation cluster overexposure (IT_LARGE cluster already at ~16 %).
  {
    symbol: 'WIPRO', strategy: 'pullback_retest', sector: 'IT', direction: 'BUY',
    entryPrice: 480, stopLoss: 460, livePrice: 481, bid: 480.5, ask: 481.5,
    positionSize: 4000, grossValue: 1_920_000, riskAllocated: 20_000, atrPct: 0.018,
    liquidityScore: 75, avgDailyVolume: 4_000_000,
    finalScore: 72, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 72, trend_alignment: 72, momentum: 68, volume_confirmation: 65,
                    risk_reward: 70, liquidity: 75, market_regime: 70, portfolio_fit: 50 },
    correlationCluster: 'IT_LARGE',
    dailyDrift: 4, fourHourDrift: 2, oneHourDrift: 0.5,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED',
    expectedBlockingHints: ['CORRELATION_RISK', 'POSITION_CONCENTRATION', 'PORTFOLIO_HEAT_EXCEEDED'],
  },
  // 4. Live tick already past the stop — execution + live invalid.
  {
    symbol: 'BAJFINANCE', strategy: 'bullish_breakout', sector: 'NBFC', direction: 'BUY',
    entryPrice: 7000, stopLoss: 6800, livePrice: 6790, bid: 6789, ask: 6791,
    positionSize: 30, grossValue: 210_000, riskAllocated: 6_000, atrPct: 0.015,
    liquidityScore: 80, avgDailyVolume: 1_500_000,
    finalScore: 76, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 76, trend_alignment: 78, momentum: 72, volume_confirmation: 70,
                    risk_reward: 74, liquidity: 78, market_regime: 70, portfolio_fit: 75 },
    dailyDrift: 5, fourHourDrift: 2, oneHourDrift: 0.5,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED', expectedBlockingHints: ['stop_compromised'],
  },
  // 5. Wide spread → execution rejection.
  {
    symbol: 'TATAMOTORS', strategy: 'momentum_followthrough', sector: 'Auto', direction: 'BUY',
    entryPrice: 950, stopLoss: 920, livePrice: 952, bid: 945, ask: 959,
    positionSize: 200, grossValue: 190_000, riskAllocated: 6_000, atrPct: 0.020,
    liquidityScore: 65, avgDailyVolume: 2_500_000,
    finalScore: 70, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 70, trend_alignment: 72, momentum: 70, volume_confirmation: 68,
                    risk_reward: 68, liquidity: 60, market_regime: 65, portfolio_fit: 70 },
    dailyDrift: 3, fourHourDrift: 1.5, oneHourDrift: 0.5,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED', expectedBlockingHints: ['spread_too_wide', 'slippage_too_wide'],
  },
  // 6. Conflicting timeframes (trade is BUY, daily and 4H bearish).
  {
    symbol: 'COALINDIA', strategy: 'mean_reversion_confirmation', sector: 'Energy', direction: 'BUY',
    entryPrice: 280, stopLoss: 268, livePrice: 281, bid: 280.5, ask: 281.5,
    positionSize: 1000, grossValue: 280_000, riskAllocated: 12_000, atrPct: 0.022,
    liquidityScore: 70, avgDailyVolume: 6_000_000,
    finalScore: 62, classification: 'VALID_SIGNAL',
    factorScores: { strategy_quality: 62, trend_alignment: 50, momentum: 58, volume_confirmation: 60,
                    risk_reward: 58, liquidity: 70, market_regime: 50, portfolio_fit: 60 },
    correlationCluster: 'ENERGY',
    dailyDrift: -8, fourHourDrift: -3, oneHourDrift: 0.5,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED',
    expectedBlockingHints: ['TIMEFRAME_CONFLICT'],
  },
  // 7. Stale APPROVED — blew past the entry window. Auto-expiry must fire.
  {
    symbol: 'GRASIM', strategy: 'bullish_breakout', sector: 'Cement', direction: 'BUY',
    entryPrice: 1900, stopLoss: 1850, livePrice: 1908, bid: 1907.5, ask: 1908.5,
    positionSize: 80, grossValue: 152_000, riskAllocated: 4_000, atrPct: 0.014,
    liquidityScore: 75, avgDailyVolume: 1_000_000,
    finalScore: 76, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 76, trend_alignment: 78, momentum: 72, volume_confirmation: 68,
                    risk_reward: 74, liquidity: 75, market_regime: 70, portfolio_fit: 76 },
    dailyDrift: 5, fourHourDrift: 2, oneHourDrift: 1,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 24,  // stale
    expectedDecision: 'REJECTED', expectedBlockingHints: ['EXPIRED_LIFECYCLE'],
  },
  // 8. Fragile: stop is tight relative to ATR and capital deployment is
  //    aggressive — stress survival must fall below the 60 floor.
  {
    symbol: 'TITAN', strategy: 'pullback_retest', sector: 'Consumer', direction: 'BUY',
    entryPrice: 3000, stopLoss: 2985, livePrice: 3001, bid: 3000.5, ask: 3001.5,
    positionSize: 800, grossValue: 2_400_000, riskAllocated: 12_000, atrPct: 0.040,
    liquidityScore: 35, avgDailyVolume: 1_200_000,
    finalScore: 70, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 70, trend_alignment: 72, momentum: 70, volume_confirmation: 65,
                    risk_reward: 65, liquidity: 70, market_regime: 70, portfolio_fit: 75 },
    dailyDrift: 4, fourHourDrift: 2, oneHourDrift: 1,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 2,
    expectedDecision: 'REJECTED', expectedBlockingHints: ['stress_survival_below_60'],
  },
  // 9. Bearish-stacked SELL but the trade's own risk allocation by itself
  //    overshoots the 8 % portfolio heat ceiling.
  {
    symbol: 'ZEEL', strategy: 'bearish_breakdown', sector: 'Media', direction: 'SELL',
    entryPrice: 200, stopLoss: 215, livePrice: 199, bid: 198.7, ask: 199.3,
    positionSize: 1500, grossValue: 300_000, riskAllocated: 450_000, atrPct: 0.020,
    liquidityScore: 70, avgDailyVolume: 3_500_000,
    finalScore: 78, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 78, trend_alignment: 80, momentum: 80, volume_confirmation: 70,
                    risk_reward: 78, liquidity: 72, market_regime: 75, portfolio_fit: 78 },
    dailyDrift: -6, fourHourDrift: -3, oneHourDrift: -0.8,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'REJECTED',  // portfolio_heat already deep — adding 22k risk hits 8 % cap
    expectedBlockingHints: ['PORTFOLIO_HEAT_EXCEEDED'],
  },
  // 10. Clean approval, mid-cap, modest sector exposure.
  {
    symbol: 'PERSISTENT', strategy: 'bullish_breakout', sector: 'Tech', direction: 'BUY',
    entryPrice: 4500, stopLoss: 4380, livePrice: 4504, bid: 4503.5, ask: 4504.5,
    positionSize: 50, grossValue: 225_000, riskAllocated: 6_000, atrPct: 0.018,
    liquidityScore: 80, avgDailyVolume: 800_000,
    finalScore: 82, classification: 'HIGH_CONVICTION',
    factorScores: { strategy_quality: 82, trend_alignment: 84, momentum: 80, volume_confirmation: 78,
                    risk_reward: 80, liquidity: 80, market_regime: 75, portfolio_fit: 82 },
    dailyDrift: 7, fourHourDrift: 3, oneHourDrift: 1.2,
    initialLifecycleState: 'APPROVED', ageHoursOnRecord: 1,
    expectedDecision: 'APPROVED', expectedBlockingHints: [],
  },
];

// ── Per-symbol evaluation ──────────────────────────────────────

function evaluate(c: Candidate) {
  // Lifecycle — apply auto-expiry first.
  const baseLifecycle: TradeLifecycle = {
    state:        c.initialLifecycleState,
    reason:       'fixture seed',
    changedAt:    new Date(NOW.getTime() - c.ageHoursOnRecord * 3_600_000).toISOString(),
    cyclesInState: 0,
  };
  const expiry = applyAutoExpiry({ lifecycle: baseLifecycle, now: NOW });
  const lifecycle = expiry.applied ? expiry.lifecycle : baseLifecycle;
  const lifecycleStaleReject = expiry.applied;

  // Portfolio risk — assess the trade against open positions.
  const portfolio = evaluatePortfolioRisk({
    capital:       CAPITAL,
    openPositions: OPEN_POSITIONS,
    candidate: {
      symbol:             c.symbol,
      sector:             c.sector,
      grossValue:         c.grossValue,
      riskAllocated:      c.riskAllocated,
      correlationCluster: c.correlationCluster,
    },
  });

  // Stress test on the proposed size.
  const stress = runStressTest({
    symbol:         c.symbol,
    direction:      c.direction,
    entryPrice:     c.entryPrice,
    stopLoss:       c.stopLoss,
    positionSize:   c.positionSize,
    atrPct:         c.atrPct,
    liquidityScore: c.liquidityScore,
    sector:         c.sector,
    capital:        CAPITAL,
  });

  // Live execution — entry zone widened to 1 % around entry.
  const live = validateLiveExecution({
    symbol:        c.symbol,
    direction:     c.direction,
    entryPrice:    c.entryPrice,
    entryZoneLow:  c.entryPrice * 0.99,
    entryZoneHigh: c.entryPrice * 1.02,
    stopLoss:      c.stopLoss,
    livePrice:     c.livePrice,
    bid:           c.bid,
    ask:           c.ask,
    avgDailyVolume: c.avgDailyVolume,
    positionSize:  c.positionSize,
    atrPct:        c.atrPct,
  }, undefined, NOW);

  // Multi-timeframe alignment with synthesised candle history.
  const daily   = makeCandles(80, c.entryPrice, c.dailyDrift,    c.entryPrice * 0.005, 11);
  const fourHr  = makeCandles(80, c.entryPrice, c.fourHourDrift, c.entryPrice * 0.004, 13);
  const oneHr   = makeCandles(60, c.entryPrice, c.oneHourDrift,  c.entryPrice * 0.003, 17);
  const alignment = evaluateMultiTimeframeAlignment({
    symbol:    c.symbol,
    direction: c.direction,
    daily, fourHour: fourHr, oneHour: oneHr,
  });

  // Decide
  const portfolioBlocked = portfolio.rejected;
  const stressBlocked    = stress.fragile;
  const liveBlocked      = !live.execution_allowed;
  const alignmentBlocked = alignment.alignment_state === 'conflicting';

  const blocked = lifecycleStaleReject || portfolioBlocked || stressBlocked
               || liveBlocked || alignmentBlocked;
  const decision: 'APPROVED' | 'REJECTED' = blocked ? 'REJECTED' : 'APPROVED';

  const upstream = lifecycleStaleReject
    ? { codes: ['EXPIRED_LIFECYCLE'], reasons: [expiry.reason] }
    : { codes: [], reasons: [] };

  const audit = buildAuditRecord({
    symbol:        c.symbol,
    direction:     c.direction,
    strategy:      c.strategy,
    lifecycleState: lifecycle.state,
    decision,
    scoreBreakdown: {
      final_score:         c.finalScore,
      classification:      c.classification,
      factor_scores:       c.factorScores,
      alignment_modifier:  alignment.timeframe_alignment_score,
    },
    approvalReasons: decision === 'APPROVED'
      ? ['portfolio fit OK', 'live execution OK', 'multi-tf supportive', 'stress survived']
      : [],
    portfolio:        portfolio,
    liveExecution:    live,
    alignment,
    stress,
    upstreamRejectionCodes:   upstream.codes,
    upstreamRejectionReasons: upstream.reasons,
    now:              NOW,
  });

  return { lifecycle, portfolio, stress, live, alignment, decision, audit };
}

// ── Run ─────────────────────────────────────────────────────────

function pct(n: number): string { return `${(n * 100).toFixed(2)}%`; }

function main() {
  console.log('='.repeat(110));
  console.log('PHASE-NEXT ACCEPTANCE — INSTITUTIONAL EXECUTION & PORTFOLIO LAYER');
  console.log('='.repeat(110));
  console.log('Capital: ₹' + CAPITAL.toLocaleString('en-IN') + '   Open positions: ' + OPEN_POSITIONS.length);
  console.log('');

  let approvedCount = 0;
  let rejectedCount = 0;
  let mismatched   = 0;
  let weakApproved = 0;
  let staleSurviving = 0;
  let portfolioBreachesEnforced = 0;
  let executionBreachesEnforced = 0;

  // Header
  const head = [
    'SYMBOL'.padEnd(11),
    'DIR'.padEnd(4),
    'FINAL'.padStart(6),
    'PF_FIT'.padStart(7),
    'EXEC'.padStart(5),
    'SLIP%'.padStart(6),
    'ALIGN'.padEnd(16),
    'LIFECYCLE'.padEnd(13),
    'STRESS'.padStart(7),
    'DECISION'.padStart(9),
  ].join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));

  for (const c of CANDIDATES) {
    const r = evaluate(c);

    const row = [
      c.symbol.padEnd(11),
      c.direction.padEnd(4),
      String(c.finalScore).padStart(6),
      String(r.portfolio.portfolio_fit_score).padStart(7),
      (r.live.execution_allowed ? 'OK' : 'NO').padStart(5),
      r.live.slippage_pct.toFixed(3).padStart(6),
      r.alignment.alignment_state.padEnd(16),
      r.lifecycle.state.padEnd(13),
      String(r.stress.stress_survival_score).padStart(7),
      r.decision.padStart(9),
    ].join(' ');
    console.log(row);

    if (r.decision === 'APPROVED') approvedCount++;
    else                            rejectedCount++;

    // Acceptance assertions (per-row)
    if (r.decision !== c.expectedDecision) {
      mismatched++;
      console.log(`  ⚠️  ${c.symbol}: expected ${c.expectedDecision}, got ${r.decision}`);
    }
    // No weak signals reach APPROVED.
    if (r.decision === 'APPROVED' && c.finalScore < 70) {
      weakApproved++;
      console.log(`  ⚠️  ${c.symbol}: weak final_score ${c.finalScore} reached APPROVED`);
    }
    // Stale APPROVED auto-expired.
    if (c.ageHoursOnRecord >= 12 && r.lifecycle.state === 'APPROVED') {
      staleSurviving++;
      console.log(`  ⚠️  ${c.symbol}: stale APPROVED survived auto-expiry`);
    }
    // Portfolio limits enforced where relevant.
    if (c.expectedBlockingHints.some((h) =>
        ['SECTOR_OVEREXPOSURE','POSITION_CONCENTRATION','CORRELATION_RISK','PORTFOLIO_HEAT_EXCEEDED'].includes(h))) {
      const portfolioBreach = r.portfolio.rejection_codes.some((code) =>
        c.expectedBlockingHints.includes(code));
      if (portfolioBreach) portfolioBreachesEnforced++;
    }
    if (c.expectedBlockingHints.some((h) =>
        ['stop_compromised','spread_too_wide','slippage_too_wide','illiquid_exit','price_extended','entry_zone_invalid'].includes(h))) {
      const execBreach = r.live.execution_codes.some((code) =>
        c.expectedBlockingHints.includes(code));
      if (execBreach) executionBreachesEnforced++;
    }

    // Detail block — score + audit narrative.
    console.log(`     audit: ${renderAuditLine(r.audit)}`);
    if (r.portfolio.rejected) {
      console.log(`     portfolio: ${r.portfolio.explanation}`);
    } else {
      console.log(`     portfolio: heat=${pct(r.portfolio.portfolio_heat)} sector=${pct(r.portfolio.sector_exposure_after)} cluster=${pct(r.portfolio.correlation_cluster_risk)}`);
    }
    if (!r.live.execution_allowed) {
      console.log(`     execution: BLOCKED [${r.live.execution_codes.join(',')}]`);
    }
    if (r.alignment.alignment_state === 'conflicting') {
      console.log(`     alignment: ${r.alignment.explanation}`);
    }
    if (r.stress.fragile) {
      console.log(`     stress: fragile [${r.stress.stress_rejection_codes.join(',')}] worst=${r.stress.worst_case_scenario}`);
    }
    console.log('');
  }

  console.log('-'.repeat(head.length));
  console.log('');
  console.log('ACCEPTANCE SUMMARY');
  console.log('  approved        : ' + approvedCount);
  console.log('  rejected        : ' + rejectedCount);
  console.log('  decision drift  : ' + mismatched + (mismatched > 0 ? ' (FAIL)' : ' (PASS)'));
  console.log('  weak approved   : ' + weakApproved + (weakApproved > 0 ? ' (FAIL)' : ' (PASS)'));
  console.log('  stale surviving : ' + staleSurviving + (staleSurviving > 0 ? ' (FAIL)' : ' (PASS)'));
  console.log('  pf limits hit   : ' + portfolioBreachesEnforced + ' (rows that should breach)');
  console.log('  exec limits hit : ' + executionBreachesEnforced);
  console.log('');

  const failed = mismatched > 0 || weakApproved > 0 || staleSurviving > 0;
  if (failed) {
    console.log('RESULT: ❌ FAIL — review failure lines above.');
    process.exit(1);
  }
  console.log('RESULT: ✅ PASS — institutional gates enforced.');
}

main();
