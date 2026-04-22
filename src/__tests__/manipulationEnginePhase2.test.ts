// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Phase 2 Acceptance Test
//
//  Pure-unit, no DB. Exercises:
//   • new advanced detectors (closeRamp, trapBreakout, trapBreakdown,
//     washActivityProxy, spoofProxy, circularInterest)
//   • risk-label aggregation
//   • signal-engine penalty math (applyHookToSignal):
//       - watch  → warning only
//       - elev/high → numeric penalty
//       - severe → rejection
//   • buildPenaltyRecord shape
//
//  Run: npx tsx src/__tests__/manipulationEnginePhase2.test.ts
// ════════════════════════════════════════════════════════════════

import {
  scanSymbol, scanSymbolSeries, deriveRiskLabels,
  applyHookToSignal, buildPenaltyRecord, buildHookResult,
} from '../lib/manipulation-engine';
import type {
  DailyBar, ManipulationSnapshot, DetectorResult, AppliedPenalty,
} from '../lib/manipulation-engine';
import type { QuantSignal } from '../lib/signal-engine/types/signalEngine.types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

// ── Synthetic data ──────────────────────────────────────────────

function day(n: number): string {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function flatBaseline(startPrice = 500, count = 30): DailyBar[] {
  const bars: DailyBar[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o * (1 + (Math.sin(i) * 0.002));
    const h = Math.max(o, c) * 1.005;
    const l = Math.min(o, c) * 0.995;
    bars.push({
      date: day(i), open: o, high: h, low: l, close: c,
      volume: 200_000, turnover: 200_000 * c,
    });
    p = c;
  }
  return bars;
}

/** Trap breakout: ramp into a 10-bar high, breakout bar with wide range
 *  + heavy volume, next bar closes well below the prior high. */
function trapBreakoutSeries(): DailyBar[] {
  const bars = flatBaseline(500, 25);
  const priorHigh = Math.max(...bars.map((b) => b.high));
  // Breakout bar
  const breakoutOpen = bars[bars.length - 1].close;
  const breakoutHigh = priorHigh * 1.05;          // 5% above level
  const breakoutClose = priorHigh * 1.02;
  bars.push({
    date: day(bars.length),
    open: breakoutOpen,
    high: breakoutHigh,
    low: breakoutOpen * 0.99,
    close: breakoutClose,
    volume: 800_000,                              // 4× avg
    turnover: 800_000 * breakoutClose,
  });
  // Failure bar — close back below prior high
  const failOpen = breakoutClose;
  const failClose = priorHigh * 0.96;             // -4% below the level
  bars.push({
    date: day(bars.length),
    open: failOpen,
    high: failOpen * 1.005,
    low: failClose * 0.995,
    close: failClose,
    volume: 600_000,
    turnover: 600_000 * failClose,
  });
  return bars;
}

/** Trap breakdown: drop through prior low, then immediate reclaim. */
function trapBreakdownSeries(): DailyBar[] {
  const bars = flatBaseline(500, 25);
  const priorLow = Math.min(...bars.map((b) => b.low));
  const breakdownOpen = bars[bars.length - 1].close;
  const breakdownLow = priorLow * 0.95;
  const breakdownClose = priorLow * 0.97;
  bars.push({
    date: day(bars.length),
    open: breakdownOpen,
    high: breakdownOpen * 1.005,
    low: breakdownLow,
    close: breakdownClose,
    volume: 800_000,
    turnover: 800_000 * breakdownClose,
  });
  // Reclaim
  const reclaimOpen = breakdownClose;
  const reclaimClose = priorLow * 1.04;            // back well above support
  bars.push({
    date: day(bars.length),
    open: reclaimOpen,
    high: reclaimClose * 1.005,
    low: reclaimOpen * 0.995,
    close: reclaimClose,
    volume: 600_000,
    turnover: 600_000 * reclaimClose,
  });
  return bars;
}

/** Wash-activity proxy: 6 bars of high turnover with tiny net change. */
function washProxySeries(): DailyBar[] {
  const bars = flatBaseline(500, 20);
  let p = bars[bars.length - 1].close;
  for (let i = 0; i < 6; i++) {
    const o = p;
    const c = o * 1.002;                           // ~+0.2% net
    bars.push({
      date: day(bars.length),
      open: o,
      high: o * 1.015,
      low: o * 0.985,
      close: c,
      volume: 800_000,                             // 4× baseline
      turnover: 800_000 * c,
    });
    p = c;
  }
  return bars;
}

/** Pump → dump synthetic sequence. */
function pumpDumpSeries(): DailyBar[] {
  const bars = flatBaseline(500, 25);
  // Pump phase
  let p = bars[bars.length - 1].close;
  for (let i = 0; i < 3; i++) {
    const o = p;
    const c = o * 1.08;
    bars.push({
      date: day(bars.length),
      open: o, high: c * 1.005, low: o * 0.998, close: c,
      volume: 1_200_000, turnover: 1_200_000 * c,
    });
    p = c;
  }
  // Dump phase
  for (let i = 0; i < 3; i++) {
    const o = p;
    const c = o * 0.93;
    bars.push({
      date: day(bars.length),
      open: o, high: o * 1.005, low: c * 0.995, close: c,
      volume: 1_400_000, turnover: 1_400_000 * c,
    });
    p = c;
  }
  return bars;
}

// ── A minimal QuantSignal stub for penalty math tests ───────────

function stubSignal(symbol = 'TEST', confidence = 70, risk = 40): QuantSignal {
  return {
    symbol,
    timeframe: 'daily',
    signalType: 'bullish_breakout',
    signalSubtype: 'fresh_breakout',
    action: 'enter_on_strength',
    marketRegime: 'Bullish',
    marketContextTag: 'Bullish',
    strengthTag: 'Actionable',
    strategyName: 'bullish breakout',
    strategyConfidence: confidence,
    contextScore: 70,
    confidenceScore: confidence,
    confidenceBand: 'Actionable' as any,
    riskScore: risk,
    riskBand: 'Moderate' as any,
    entry: { type: 'breakout_confirmation' as any, zoneLow: 100, zoneHigh: 102 },
    stopLoss: 95,
    targets: { target1: 110, target2: 120 },
    rewardRiskApprox: 2.5,
    reasons: [],
    warnings: [],
    features: {} as any,
    relativeStrength: {} as any,
    confidenceBreakdown: {} as any,
    riskBreakdown: {} as any,
    status: 'active',
    generatedAt: new Date().toISOString(),
  };
}

// Build a hook from raw fields without going through the DB.
function fakeHook(score: number, band: 'low'|'watch'|'elevated'|'high'|'severe') {
  return {
    symbol: 'X',
    snapshotDate: '2026-04-10',
    score,
    band,
    shouldPenalize: band !== 'low' && band !== 'watch',
    shouldReject: band === 'severe',
    warning: band === 'low' ? null : `Band=${band} score=${score}`,
    suggestedPenalty: band === 'severe' ? 25 : band === 'high' ? 20 : band === 'elevated' ? 10 : 0,
    topEvents: [],
  };
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Manipulation Engine — Phase 2 Acceptance Test');
  console.log('══════════════════════════════════════════════════\n');

  // 1. Trap breakout detector ─────────────────────────────────
  const trapUp = trapBreakoutSeries();
  const trapUpSnap = scanSymbol('TRAPUP', trapUp);
  const trapUpDet = trapUpSnap?.triggeredEvents.find((e) => e.detectorName === 'trapBreakout');
  check('trap breakout: snapshot built', !!trapUpSnap, '');
  check('trap breakout: detector triggered',
    !!trapUpDet?.triggered,
    trapUpDet?.detectorLabel ?? '');
  check('trap breakout: severity ≥ medium',
    trapUpDet?.triggered && ['medium', 'high', 'severe'].includes(trapUpDet.severity),
    `severity=${trapUpDet?.severity}`);

  // 2. Trap breakdown detector ────────────────────────────────
  const trapDown = trapBreakdownSeries();
  const trapDownSnap = scanSymbol('TRAPDN', trapDown);
  const trapDownDet = trapDownSnap?.triggeredEvents.find((e) => e.detectorName === 'trapBreakdown');
  check('trap breakdown: detector triggered',
    !!trapDownDet?.triggered,
    trapDownDet?.detectorLabel ?? '');

  // 3. Wash-activity proxy ────────────────────────────────────
  const wash = washProxySeries();
  const washSeries = scanSymbolSeries('WASH', wash);
  const lastWash = washSeries[washSeries.length - 1];
  const washDet = lastWash?.triggeredEvents.find((e) => e.detectorName === 'washActivityProxy');
  check('wash proxy: detector triggered',
    !!washDet?.triggered,
    washDet?.detectorLabel ?? '');
  check('wash proxy: label is explicitly probabilistic',
    !!washDet?.detectorLabel && /proxy/i.test(washDet.detectorLabel),
    washDet?.detectorLabel ?? '');

  // 4. Close-ramp detector (pump series creates ramp closes) ──
  const pdSeries = scanSymbolSeries('PD', pumpDumpSeries());
  const peakPump = pdSeries.slice(0, pdSeries.length - 3).pop()!;  // bar at end of pump
  const closeRampDet = peakPump.triggeredEvents.find((e) => e.detectorName === 'closeRamp');
  check('close ramp: detector present in pump bar',
    !!closeRampDet?.triggered,
    closeRampDet?.detectorLabel ?? '');

  // 5. Risk-label aggregation ─────────────────────────────────
  const labels = deriveRiskLabels([
    { detectorName: 'pumpRisk', triggered: true } as DetectorResult,
    { detectorName: 'closeRamp', triggered: true } as DetectorResult,
    { detectorName: 'washActivityProxy', triggered: true } as DetectorResult,
  ]);
  check('labels: pump_setup derived', labels.includes('probable_pump_setup'), labels.join(','));
  check('labels: wash_proxy derived', labels.includes('wash_proxy_observed'), '');
  check('labels: operator_activity from closeRamp', labels.includes('probable_operator_activity'), '');

  // 6. Snapshot exposes riskLabels ────────────────────────────
  check('snapshot: riskLabels populated when detectors fire',
    Array.isArray(trapUpSnap?.riskLabels) && trapUpSnap!.riskLabels!.length > 0,
    (trapUpSnap?.riskLabels ?? []).join(','));

  // 7. Penalty math — watch band → warning only ───────────────
  {
    const sig = stubSignal('A', 70, 40);
    const before = { conf: sig.confidenceScore, risk: sig.riskScore };
    const result = applyHookToSignal(sig, fakeHook(30, 'watch'));
    check('penalty: watch keeps confidence',
      sig.confidenceScore === before.conf && sig.riskScore === before.risk,
      `conf=${sig.confidenceScore} risk=${sig.riskScore}`);
    check('penalty: watch adds a warning',
      sig.warnings.length === 1 && sig.warnings[0].toLowerCase().includes('watch'),
      sig.warnings[0]);
    check('penalty: watch is not a rejection',
      sig.status === 'active' && !result.rejected, '');
  }

  // 8. Penalty math — elevated → -10 conf / +5 risk ───────────
  {
    const sig = stubSignal('B', 70, 40);
    applyHookToSignal(sig, fakeHook(60, 'elevated'));
    check('penalty: elevated reduces confidence by 10',
      sig.confidenceScore === 60, `conf=${sig.confidenceScore}`);
    check('penalty: elevated raises risk by 5',
      sig.riskScore === 45, `risk=${sig.riskScore}`);
  }

  // 9. Penalty math — high → -20 / +10 ────────────────────────
  {
    const sig = stubSignal('C', 70, 40);
    applyHookToSignal(sig, fakeHook(78, 'high'));
    check('penalty: high reduces confidence by 20',
      sig.confidenceScore === 50, `conf=${sig.confidenceScore}`);
  }

  // 10. Penalty math — severe → rejected ─────────────────────
  {
    const sig = stubSignal('D', 80, 40);
    const result = applyHookToSignal(sig, fakeHook(92, 'severe'));
    check('penalty: severe sets status=invalidated',
      sig.status === 'invalidated', `status=${sig.status}`);
    check('penalty: severe reports rejected=true',
      result.rejected === true, '');
    check('penalty: severe adds warning',
      sig.warnings.some((w) => w.toLowerCase().includes('severe')), '');
  }

  // 11. Penalty math — confidence floors at 0 ─────────────────
  {
    const sig = stubSignal('E', 5, 95);
    applyHookToSignal(sig, fakeHook(95, 'severe'));
    check('penalty: confidence does not go below 0',
      sig.confidenceScore >= 0, `conf=${sig.confidenceScore}`);
    check('penalty: risk does not exceed 100',
      sig.riskScore <= 100, `risk=${sig.riskScore}`);
  }

  // 12. buildPenaltyRecord skips zero-effect penalties ────────
  {
    const sig = stubSignal('F');
    const applied: AppliedPenalty = {
      signal: sig, hook: fakeHook(10, 'low'),
      confidencePenalty: 0, riskPenalty: 0, rejected: false, warning: null, snapshotId: 7,
    };
    check('record: zero-effect penalty returns null',
      buildPenaltyRecord(applied, 123) === null, '');
  }

  // 13. buildPenaltyRecord builds proper row when penalised ──
  {
    const sig = stubSignal('G');
    const applied: AppliedPenalty = {
      signal: sig, hook: fakeHook(80, 'high'),
      confidencePenalty: 20, riskPenalty: 10, rejected: false,
      warning: 'High manipulation suspicion (80/100)', snapshotId: 99,
    };
    const rec = buildPenaltyRecord(applied, 555);
    check('record: penalised → record built',
      !!rec && rec.confidencePenalty === 20 && rec.snapshotId === 99 && rec.signalId === '555',
      JSON.stringify(rec));
  }

  // 14. buildHookResult: severe band consistency ─────────────
  {
    const fakeSnap: ManipulationSnapshot = {
      symbol: 'Z', snapshotDate: '2026-04-10',
      manipulationScore: 90, suspicionBand: 'severe',
      features: {} as any, triggeredEvents: [],
      explanation: 'severe',
    };
    const hook = buildHookResult(fakeSnap, 'Z');
    check('hook: severe → shouldReject=true',
      hook.shouldReject && hook.shouldPenalize, '');
  }

  // 15. Detector contract for ALL detectors ──────────────────
  const allShape = pdSeries[pdSeries.length - 1].triggeredEvents.every(
    (e) =>
      typeof e.detectorName === 'string' &&
      typeof e.eventType === 'string' &&
      typeof e.triggered === 'boolean' &&
      typeof e.detectorScore === 'number' &&
      Array.isArray(e.evidence),
  );
  check('detector contract: every Phase 2 detector returns valid shape', allShape, '');

  // ── Report ────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════\n');
  for (const c of checks) {
    const icon = c.passed ? '✅' : '❌';
    console.log(`  ${icon} ${c.name.padEnd(64)} ${c.detail}`);
  }
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.length - passed;
  console.log(`\n  Total: ${checks.length}  |  Passed: ${passed}  |  Failed: ${failed}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ Test crashed:', err);
  process.exit(1);
});
