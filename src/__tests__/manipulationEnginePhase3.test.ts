// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Phase 3 Acceptance Test
//
//  Pure-unit, no DB. Exercises:
//   • action engine band → action mapping
//   • watchlist evaluator + diff
//   • cooling-off and remove-after-cooling logic
//   • bucketTradesByScore (analytics core)
//   • buildCalibrationSnapshots
//   • buildBacktestTag (point-in-time scan + filter)
//
//  Run: npx tsx src/__tests__/manipulationEnginePhase3.test.ts
// ════════════════════════════════════════════════════════════════

import {
  decideActions, DEFAULT_ACTION_RULES,
  evaluateWatchlists, diffWatchlistState,
  bucketTradesByScore, bandToMinScore,
  buildCalibrationSnapshots,
  buildBacktestTag,
} from '../lib/manipulation-engine';
import type {
  DailyBar, ManipulationSnapshot, WatchlistEntry, DetectorResult, ManipulationFeatures,
} from '../lib/manipulation-engine';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

// ── Helpers ─────────────────────────────────────────────────────

function day(n: number): string {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function emptyFeatures(): ManipulationFeatures {
  return {
    date: '2026-04-10', symbol: 'X',
    volumeVs20dAvg: 1, turnoverVs20dAvg: 1, streakOfHighVolumeDays: 0, volumePriceDivergenceFlag: false,
    bodyPctOfRange: 0.5, upperShadowPct: 0.2, lowerShadowPct: 0.2, closeLocationInRange: 0.5,
    gapPct: 0, trueRangePct: 1, abnormalRangeFlag: false,
    return1d: 0, return3d: 0, return5d: 0,
    reversalAfterSpikeFlag: false, breakoutFollowthroughFlag: null, exhaustionFlag: false,
    avgVolume20: 200_000, avgTurnover20: 1_000_000, priceImpactProxy: 0, illiquidityRiskFlag: false,
    repeatedRampPattern: false, repeatedDistributionPattern: false,
    eventClusterCount: 0, anomalyDensity20d: 0,
  };
}

function fakeSnapshot(opts: Partial<ManipulationSnapshot> & { score: number; band: ManipulationSnapshot['suspicionBand'] }): ManipulationSnapshot {
  return {
    symbol: 'X',
    snapshotDate: '2026-04-10',
    manipulationScore: opts.score,
    suspicionBand: opts.band,
    features: opts.features ?? emptyFeatures(),
    triggeredEvents: opts.triggeredEvents ?? [],
    explanation: opts.explanation ?? '',
    riskLabels: opts.riskLabels,
  };
}

function flatBaseline(startPrice = 500, count = 30): DailyBar[] {
  const bars: DailyBar[] = [];
  let p = startPrice;
  for (let i = 0; i < count; i++) {
    const o = p;
    const c = o * (1 + Math.sin(i) * 0.002);
    bars.push({
      date: day(i), open: o, high: Math.max(o, c) * 1.005, low: Math.min(o, c) * 0.995, close: c,
      volume: 200_000, turnover: 200_000 * c,
    });
    p = c;
  }
  return bars;
}

// ── Tests ───────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Manipulation Engine — Phase 3 Acceptance Test');
  console.log('══════════════════════════════════════════════════\n');

  // 1. Action registry — band mapping ─────────────────────────
  {
    const low = decideActions('low');
    check('action: low has no actions', low.actions.length === 0 && !low.suppress, '');
    const watch = decideActions('watch');
    check('action: watch is warning_only',
      watch.actions.length === 1 && watch.actions[0] === 'warning_only', '');
    const elevated = decideActions('elevated');
    check('action: elevated reduces confidence',
      elevated.confidenceDelta === 10 && elevated.riskDelta === 5 && elevated.rankDelta === 2,
      `conf=${elevated.confidenceDelta} risk=${elevated.riskDelta}`);
    const high = decideActions('high');
    check('action: high requires manual review',
      high.manualReview && high.actions.includes('watchlist_only'), '');
    const severe = decideActions('severe');
    check('action: severe suppresses signal',
      severe.suppress && severe.actions.includes('suppress_signal'), '');
    check('action: severe also requires manual review', severe.manualReview, '');
  }

  // 2. Action registry — custom rule override ────────────────
  {
    const customRules = {
      ...DEFAULT_ACTION_RULES,
      elevated: {
        ...DEFAULT_ACTION_RULES.elevated,
        confidenceDelta: 50,
      },
    };
    const dec = decideActions('elevated', customRules);
    check('action: custom rule override applied',
      dec.confidenceDelta === 50, `delta=${dec.confidenceDelta}`);
  }

  // 3. Watchlist evaluator — clean snapshot → no membership ──
  {
    const snap = fakeSnapshot({ score: 10, band: 'low' });
    const decisions = evaluateWatchlists(snap);
    check('watchlist: low band qualifies for nothing',
      decisions.every((d) => !d.shouldBeListed), '');
  }

  // 4. Watchlist evaluator — elevated → suspicious_symbols ───
  {
    const snap = fakeSnapshot({ score: 60, band: 'elevated' });
    const decisions = evaluateWatchlists(snap);
    const susp = decisions.find((d) => d.watchlistType === 'suspicious_symbols');
    check('watchlist: elevated → suspicious_symbols qualifies',
      !!susp?.shouldBeListed, '');
    const op = decisions.find((d) => d.watchlistType === 'high_risk_operator');
    check('watchlist: elevated alone does NOT qualify high_risk_operator',
      !op?.shouldBeListed, '');
  }

  // 5. Watchlist evaluator — high + closeRamp → operator list ─
  {
    const closeRampDet: DetectorResult = {
      detectorName: 'closeRamp', eventType: 'suspicious_close_ramping',
      triggered: true, detectorScore: 70, detectorLabel: 'ramp', severity: 'high',
      confidence: 0.7, evidence: [],
    };
    const snap = fakeSnapshot({ score: 75, band: 'high', triggeredEvents: [closeRampDet] });
    const decisions = evaluateWatchlists(snap);
    const op = decisions.find((d) => d.watchlistType === 'high_risk_operator');
    check('watchlist: high + closeRamp → operator list qualifies',
      !!op?.shouldBeListed, '');
  }

  // 6. Watchlist evaluator — event cluster ────────────────────
  {
    const features = { ...emptyFeatures(), anomalyDensity20d: 0.4, eventClusterCount: 8 };
    const snap = fakeSnapshot({ score: 40, band: 'watch', features });
    const decisions = evaluateWatchlists(snap);
    const ec = decisions.find((d) => d.watchlistType === 'event_cluster');
    check('watchlist: high anomaly density → event_cluster qualifies',
      !!ec?.shouldBeListed, '');
  }

  // 7. Diff: add when previously absent ───────────────────────
  {
    const snap = fakeSnapshot({ score: 60, band: 'elevated' });
    const decisions = evaluateWatchlists(snap);
    const changes = diffWatchlistState(snap, decisions, []);
    const adds = changes.filter((c) => c.changeType === 'added');
    check('diff: add when no current entry', adds.length >= 1, `adds=${adds.length}`);
  }

  // 8. Diff: cooling-off when no longer qualifies ────────────
  {
    const snap = fakeSnapshot({ score: 10, band: 'low' });
    const decisions = evaluateWatchlists(snap);
    const current: WatchlistEntry[] = [{
      symbol: 'X', watchlistType: 'suspicious_symbols',
      scoreAtAdd: 60, bandAtAdd: 'elevated',
      reason: 'previously elevated', coolingOffUntil: null,
    }];
    const changes = diffWatchlistState(snap, decisions, current, '2026-04-10');
    const downgrades = changes.filter((c) => c.changeType === 'downgraded');
    check('diff: drops to cooling-off when no longer qualifies',
      downgrades.length === 1, `downgrades=${downgrades.length}`);
    check('diff: cooling-off reason embeds expiry date',
      !!downgrades[0]?.reason && /until \d{4}-\d{2}-\d{2}/.test(downgrades[0].reason),
      downgrades[0]?.reason ?? '');
  }

  // 9. Diff: remove after cooling-off expired ─────────────────
  {
    const snap = fakeSnapshot({ score: 10, band: 'low' });
    const decisions = evaluateWatchlists(snap);
    const current: WatchlistEntry[] = [{
      symbol: 'X', watchlistType: 'suspicious_symbols',
      scoreAtAdd: 60, bandAtAdd: 'elevated',
      reason: 'previous', coolingOffUntil: '2026-04-01',
    }];
    const changes = diffWatchlistState(snap, decisions, current, '2026-04-10');
    const removes = changes.filter((c) => c.changeType === 'removed');
    check('diff: removed after cooling-off expired', removes.length === 1, '');
  }

  // 10. Diff: refresh when still qualifying ──────────────────
  {
    const snap = fakeSnapshot({ score: 65, band: 'elevated' });
    const decisions = evaluateWatchlists(snap);
    const current: WatchlistEntry[] = [{
      symbol: 'X', watchlistType: 'suspicious_symbols',
      scoreAtAdd: 60, bandAtAdd: 'elevated',
      reason: 'previously elevated', coolingOffUntil: null,
    }];
    const changes = diffWatchlistState(snap, decisions, current, '2026-04-10');
    const refresh = changes.find(
      (c) => c.changeType === 'refreshed' && c.watchlistType === 'suspicious_symbols',
    );
    check('diff: refresh when still qualifying', !!refresh, '');
  }

  // 11. Analytics — bucketTradesByScore ──────────────────────
  {
    const trades = [
      { score: 10, outcome: 'win',  pnlPct: 1.5 },
      { score: 12, outcome: 'loss', pnlPct: -0.8 },
      { score: 30, outcome: 'win',  pnlPct: 2.0 },
      { score: 60, outcome: 'loss', pnlPct: -1.2 },
      { score: 75, outcome: 'loss', pnlPct: -2.5 },
      { score: 90, outcome: 'loss', pnlPct: -3.5 },
    ];
    const buckets = bucketTradesByScore(trades);
    const low = buckets.find((b) => b.band === 'low')!;
    const severe = buckets.find((b) => b.band === 'severe')!;
    check('analytics: bucket count = 5 bands', buckets.length === 5, `${buckets.length}`);
    check('analytics: low bucket has 2 trades', low.sampleSize === 2, `${low.sampleSize}`);
    check('analytics: severe bucket has 1 loss',
      severe.sampleSize === 1 && severe.winRate === 0, `${severe.winRate}`);
    check('analytics: low bucket win rate = 50%', low.winRate === 50, `${low.winRate}`);
  }

  // 12. Analytics — bandToMinScore boundaries ────────────────
  {
    check('analytics: bandToMinScore(low)=0', bandToMinScore('low') === 0, '');
    check('analytics: bandToMinScore(elevated)=50', bandToMinScore('elevated') === 50, '');
    check('analytics: bandToMinScore(severe)=85', bandToMinScore('severe') === 85, '');
  }

  // 13. Calibration snapshots ────────────────────────────────
  {
    const trades = [
      { score: 5,  outcome: 'win',  pnlPct: 1.0, isFalseBreakout: false },
      { score: 10, outcome: 'win',  pnlPct: 1.0, isFalseBreakout: false },
      { score: 80, outcome: 'loss', pnlPct: -2.0, isFalseBreakout: true },
      { score: 90, outcome: 'loss', pnlPct: -2.5, isFalseBreakout: true },
    ];
    const snaps = buildCalibrationSnapshots('run-1', '2026-04-10', trades);
    check('calibration: 5 records produced', snaps.length === 5, `${snaps.length}`);
    const high = snaps.find((s) => s.bucketBand === 'high');
    const severe = snaps.find((s) => s.bucketBand === 'severe');
    check('calibration: severe bucket false-breakout rate = 100%',
      severe?.falseBreakoutRate === 100, `${severe?.falseBreakoutRate}`);
    check('calibration: low bucket has wins',
      (snaps.find((s) => s.bucketBand === 'low')?.winRate ?? 0) === 100, '');
    void high;
  }

  // 14. Backtest tag — flat series stays low, no exclusion ───
  {
    const bars = flatBaseline();
    const tag = buildBacktestTag('FLAT', bars, bars[bars.length - 1].date, 50);
    check('tag: flat series produces a tag', !!tag, '');
    check('tag: flat series score < 50',
      (tag?.manipulationScore ?? 100) < 50, `score=${tag?.manipulationScore}`);
    check('tag: flat series not excluded by filter',
      tag?.excluded === false, '');
  }

  // 15. Backtest tag — point-in-time safety ──────────────────
  {
    // Build bars with a pump appended at the very end. Tag with a
    // signalDate that is BEFORE the pump — the score must be low
    // because the pump bars must be invisible to the scan.
    const bars = flatBaseline();
    const cutoff = bars[bars.length - 1].date;
    const pumpDay = day(bars.length);
    const last = bars[bars.length - 1];
    bars.push({
      date: pumpDay, open: last.close, high: last.close * 1.10,
      low: last.close * 0.99, close: last.close * 1.08,
      volume: 2_000_000, turnover: 2_000_000 * last.close * 1.08,
    });
    const tag = buildBacktestTag('PT', bars, cutoff, 50);
    check('tag: point-in-time excludes future pump bars',
      (tag?.manipulationScore ?? 100) < 50, `score=${tag?.manipulationScore}`);
  }

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
