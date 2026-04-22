// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Phase 1 Acceptance Test
//
//  Pure-unit test: synthetic OHLCV series drive the feature builder,
//  detectors, scoring, and integration hook. No DB access — this
//  runs in any environment (CI, dev, offline).
//
//  Run: npx tsx src/__tests__/manipulationEnginePhase1.test.ts
// ════════════════════════════════════════════════════════════════

import {
  scanSymbol, scanSymbolSeries, computeFeaturesForSeries,
  buildHookResult, THRESHOLDS,
} from '../lib/manipulation-engine';
import type { DailyBar } from '../lib/manipulation-engine';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

// ── Synthetic data builders ─────────────────────────────────────

function day(n: number): string {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

/** Flat, healthy baseline — 30 bars drifting mildly upward on normal volume. */
function flatBaseline(startPrice = 500, count = 30): DailyBar[] {
  const bars: DailyBar[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o * (1 + (Math.sin(i) * 0.002));
    const h = Math.max(o, c) * 1.005;
    const l = Math.min(o, c) * 0.995;
    bars.push({
      date: day(i),
      open: o, high: h, low: l, close: c,
      volume: 200_000 + (i % 3) * 5_000,
      turnover: (200_000 + (i % 3) * 5_000) * c,
    });
    p = c;
  }
  return bars;
}

/** Append a pump-like pattern: 3 ramp days with rising close + heavy volume. */
function appendPump(bars: DailyBar[]): DailyBar[] {
  const last = bars[bars.length - 1];
  let p = last.close;
  for (let i = 0; i < 3; i++) {
    const o = p;
    const c = o * 1.07;            // +7% per day
    const h = c * 1.005;           // closes near high → ramping
    const l = o * 0.998;
    bars.push({
      date: day(bars.length),
      open: o, high: h, low: l, close: c,
      volume: 1_200_000,            // ~6× baseline
      turnover: 1_200_000 * c,
    });
    p = c;
  }
  return bars;
}

/** Append repeated long-upper-wick distribution bars. */
function appendDistribution(bars: DailyBar[]): DailyBar[] {
  const last = bars[bars.length - 1];
  let p = last.close;
  for (let i = 0; i < 5; i++) {
    const o = p;
    const h = o * 1.05;             // spike up intraday
    const c = o * 0.998;            // close back near open
    const l = o * 0.99;
    bars.push({
      date: day(bars.length),
      open: o, high: h, low: l, close: c,
      volume: 500_000,
      turnover: 500_000 * c,
    });
    p = c;
  }
  return bars;
}

/** Append a large gap-up that fades into close. */
function appendGapFade(bars: DailyBar[]): DailyBar[] {
  const last = bars[bars.length - 1];
  const o = last.close * 1.05;      // +5% gap up
  const h = o * 1.01;
  const l = last.close * 0.98;
  const c = last.close * 0.99;      // faded hard → close near low
  bars.push({
    date: day(bars.length),
    open: o, high: h, low: l, close: c,
    volume: 800_000,
    turnover: 800_000 * c,
  });
  return bars;
}

/** Build a low-liquidity illiquid marking series. */
function illiquidMarkingSeries(): DailyBar[] {
  const bars: DailyBar[] = [];
  let p = 120;
  // 25 flat bars at very low volume
  for (let i = 0; i < 25; i++) {
    const o = p;
    const c = o * (1 + (Math.random() - 0.5) * 0.002);
    bars.push({
      date: day(i),
      open: o, high: Math.max(o, c) * 1.001, low: Math.min(o, c) * 0.999, close: c,
      volume: 8_000,                // very illiquid
      turnover: 8_000 * c,
    });
    p = c;
  }
  // Marking bar: +5% move on tiny volume, close at day high
  const last = bars[bars.length - 1];
  const o = last.close;
  const c = o * 1.05;
  bars.push({
    date: day(bars.length),
    open: o, high: c, low: o * 0.999, close: c,   // CLR = 1.0 (close at high)
    volume: 9_500,                                 // ~1.2× avg — low
    turnover: 9_500 * c,
  });
  return bars;
}

// ── Tests ──────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Manipulation Engine — Phase 1 Acceptance Test');
  console.log('══════════════════════════════════════════════════\n');

  // 1. Feature builder produces stable output ─────────────────
  const flat = flatBaseline();
  const flatFeatures = computeFeaturesForSeries('FLAT', flat);
  check('features: 1:1 with input bars', flatFeatures.length === flat.length, `${flatFeatures.length}/${flat.length}`);
  check('features: stable volume ratio on flat data',
    Math.abs(flatFeatures[flatFeatures.length - 1].volumeVs20dAvg - 1) < 0.5,
    `${flatFeatures[flatFeatures.length - 1].volumeVs20dAvg}`);
  check('features: body/shadow flat-day candle sanity',
    flatFeatures[flatFeatures.length - 1].closeLocationInRange >= 0 &&
    flatFeatures[flatFeatures.length - 1].closeLocationInRange <= 1, '');

  // 2. Flat data → low suspicion ──────────────────────────────
  const flatSnap = scanSymbol('FLAT', flat);
  check('scan: flat series produces snapshot', !!flatSnap, '');
  check('scan: flat series score is low', (flatSnap?.manipulationScore ?? 100) < 25, `score=${flatSnap?.manipulationScore}`);
  check('scan: flat series band = low', flatSnap?.suspicionBand === 'low', `${flatSnap?.suspicionBand}`);

  // 3. Pump pattern → suspicion rises ─────────────────────────
  const pumpBars = appendPump(flatBaseline());
  const pumpSnap = scanSymbol('PUMP', pumpBars);
  check('pump: snapshot built', !!pumpSnap, '');
  check('pump: score rises above flat', (pumpSnap?.manipulationScore ?? 0) > (flatSnap?.manipulationScore ?? 0),
    `pump=${pumpSnap?.manipulationScore} flat=${flatSnap?.manipulationScore}`);
  check('pump: pump detector triggered',
    pumpSnap?.triggeredEvents.some((e) => e.detectorName === 'pumpRisk' && e.triggered) ?? false, '');
  check('pump: volume spike detector triggered',
    pumpSnap?.triggeredEvents.some((e) => e.detectorName === 'volumeSpike' && e.triggered) ?? false, '');
  check('pump: score reaches at least Watch band', (pumpSnap?.manipulationScore ?? 0) >= 25,
    `score=${pumpSnap?.manipulationScore}`);

  // 4. Repeated upper-wick distribution ───────────────────────
  const distBars = appendDistribution(flatBaseline());
  // The detector needs 3+ long-upper-wick bars in window; we add 5.
  // Evaluate scan on a LATER bar so all 5 wicks are in history.
  const distSeries = scanSymbolSeries('DIST', distBars);
  const lastDist = distSeries[distSeries.length - 1];
  check('distribution: snapshot built', !!lastDist, '');
  check('distribution: upperWickDistribution detector triggered',
    lastDist?.triggeredEvents.some((e) => e.detectorName === 'upperWickDistribution' && e.triggered) ?? false,
    lastDist?.triggeredEvents.find((e) => e.detectorName === 'upperWickDistribution')?.detectorLabel ?? '');

  // 5. Gap-and-fade ──────────────────────────────────────────
  const gapBars = appendGapFade(flatBaseline());
  const gapSnap = scanSymbol('GAP', gapBars);
  check('gap fade: gapFade detector triggered',
    gapSnap?.triggeredEvents.some((e) => e.detectorName === 'gapFade' && e.triggered) ?? false, '');

  // 6. Illiquid marking ──────────────────────────────────────
  const illBars = illiquidMarkingSeries();
  const illSnap = scanSymbol('ILL', illBars, { symbol: 'ILL', avgVolume20: 8_000, avgTurnover20: 960_000 });
  check('illiquid marking: snapshot built', !!illSnap, '');
  check('illiquid marking: detector triggered',
    illSnap?.triggeredEvents.some((e) => e.detectorName === 'illiquidMarking' && e.triggered) ?? false,
    illSnap?.triggeredEvents.find((e) => e.detectorName === 'illiquidMarking')?.detectorLabel ?? '');
  check('illiquid marking: fragility boost present in score',
    (illSnap?.manipulationScore ?? 0) > 0, `score=${illSnap?.manipulationScore}`);

  // 7. Score bands & explanation ─────────────────────────────
  check('score: pump explanation is non-empty',
    (pumpSnap?.explanation?.length ?? 0) > 0, pumpSnap?.explanation ?? '');
  check('score: evidence arrays populated',
    (pumpSnap?.triggeredEvents.every((e) => Array.isArray(e.evidence)) ?? false), '');

  // 8. Signal engine hook ────────────────────────────────────
  const hook = buildHookResult(pumpSnap, 'PUMP');
  check('hook: returns symbol', hook.symbol === 'PUMP', '');
  check('hook: score matches snapshot', hook.score === (pumpSnap?.manipulationScore ?? -1), '');
  check('hook: topEvents populated when detectors triggered', hook.topEvents.length > 0,
    `count=${hook.topEvents.length}`);
  check('hook: penalty/reject flags consistent with thresholds',
    (hook.score < THRESHOLDS.PENALTY_BAND_THRESHOLD) === !hook.shouldPenalize &&
    (hook.score < THRESHOLDS.REJECT_BAND_THRESHOLD) === !hook.shouldReject, '');

  // Null hook fallback
  const nullHook = buildHookResult(null, 'NIL');
  check('hook: null snapshot → band=low, penalty=0',
    nullHook.band === 'low' && !nullHook.shouldPenalize && nullHook.suggestedPenalty === 0, '');

  // 9. Every detector emits consistent shape ─────────────────
  const shapeOk = pumpSnap?.triggeredEvents.every(
    (e) =>
      typeof e.detectorName === 'string' &&
      typeof e.eventType === 'string' &&
      typeof e.triggered === 'boolean' &&
      typeof e.detectorScore === 'number' &&
      typeof e.confidence === 'number' &&
      ['low', 'medium', 'high', 'severe'].includes(e.severity) &&
      Array.isArray(e.evidence),
  ) ?? false;
  check('detector contract: all detectors return the required shape', shapeOk, '');

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
