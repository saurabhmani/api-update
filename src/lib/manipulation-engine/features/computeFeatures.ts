// ════════════════════════════════════════════════════════════════
//  Feature Builder — Single Source of Truth for Bar-Level Features
//
//  This module is the ONLY place that touches raw OHLCV. Every
//  detector and scorer operates on ManipulationFeatures objects so
//  the reasoning logic stays separated from the math.
// ════════════════════════════════════════════════════════════════

import type {
  DailyBar, ManipulationFeatures, SymbolMeta,
} from '../types';
import { THRESHOLDS } from '../constants/thresholds';
import { clamp, mean, pct, ratio, round2, round4 } from '../utils/math';

/**
 * Compute features for every bar in a symbol's history.
 * Returns an array aligned 1:1 with the input bars. Early bars (before
 * the lookback window is filled) still get a feature row — some fields
 * will simply be 0 or based on what history is available.
 */
export function computeFeaturesForSeries(
  symbol: string,
  bars: DailyBar[],
  meta: SymbolMeta = { symbol },
  lookback: number = 20,
): ManipulationFeatures[] {
  const out: ManipulationFeatures[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prev = i > 0 ? bars[i - 1] : null;

    // Lookback slice — exclusive of current bar so today doesn't pollute
    // its own baseline. Falls back gracefully for early bars.
    const windowStart = Math.max(0, i - lookback);
    const window = bars.slice(windowStart, i);

    // ── Volume baseline ──────────────────────────────────────────
    const volumes = window.map((b) => b.volume);
    const avgVolume20 = volumes.length > 0 ? mean(volumes) : bar.volume;
    const volumeVs20dAvg = round4(ratio(bar.volume, avgVolume20 || 1));

    const turnovers = window
      .map((b) => b.turnover)
      .filter((t): t is number => typeof t === 'number');
    const avgTurnover20 = turnovers.length > 0 ? mean(turnovers) : null;
    const turnoverVs20dAvg = avgTurnover20 != null && bar.turnover != null
      ? round4(ratio(bar.turnover, avgTurnover20 || 1))
      : null;

    // ── Volume streak ────────────────────────────────────────────
    let streakOfHighVolumeDays = 0;
    for (let k = i; k >= 0; k--) {
      const wk = bars.slice(Math.max(0, k - lookback), k);
      if (wk.length === 0) break;
      const kAvg = mean(wk.map((b) => b.volume));
      if (kAvg > 0 && bars[k].volume >= 2 * kAvg) streakOfHighVolumeDays++;
      else break;
    }

    // ── Candle structure ─────────────────────────────────────────
    const range = bar.high - bar.low;
    const bodyAbs = Math.abs(bar.close - bar.open);
    const upperShadow = bar.high - Math.max(bar.open, bar.close);
    const lowerShadow = Math.min(bar.open, bar.close) - bar.low;

    const bodyPctOfRange = range > 0 ? round4(bodyAbs / range) : 0;
    const upperShadowPct = range > 0 ? round4(upperShadow / range) : 0;
    const lowerShadowPct = range > 0 ? round4(lowerShadow / range) : 0;
    const closeLocationInRange = range > 0
      ? round4(clamp((bar.close - bar.low) / range, 0, 1))
      : 0.5;

    const gapPct = prev && prev.close > 0
      ? round4(pct(bar.open - prev.close, prev.close))
      : 0;
    const trueRange = prev
      ? Math.max(
          bar.high - bar.low,
          Math.abs(bar.high - prev.close),
          Math.abs(bar.low - prev.close),
        )
      : range;
    const trueRangePct = prev && prev.close > 0
      ? round4(pct(trueRange, prev.close))
      : 0;
    const abnormalRangeFlag = trueRangePct >= THRESHOLDS.ABNORMAL_RANGE_PCT;

    // ── Returns ──────────────────────────────────────────────────
    const return1d = prev && prev.close > 0
      ? round4(pct(bar.close - prev.close, prev.close))
      : 0;
    const return3d = i >= 3 && bars[i - 3].close > 0
      ? round4(pct(bar.close - bars[i - 3].close, bars[i - 3].close))
      : 0;
    const return5d = i >= 5 && bars[i - 5].close > 0
      ? round4(pct(bar.close - bars[i - 5].close, bars[i - 5].close))
      : 0;

    // ── Volume-price divergence: high volume but flat/down ──────
    const highVolume = volumeVs20dAvg >= THRESHOLDS.HIGH_VOLUME_MULT;
    const volumePriceDivergenceFlag = highVolume && return1d <= 0.5;

    // ── Reversal-after-spike (needs bar i-1 to have been spiky) ─
    // This flag fires on the *reversal* bar, not on the spike bar itself.
    let reversalAfterSpikeFlag = false;
    if (i >= 1) {
      const prevPrev = i >= 2 ? bars[i - 2] : null;
      const prevReturn = prevPrev && prevPrev.close > 0
        ? pct(prev!.close - prevPrev.close, prevPrev.close)
        : 0;
      if (prevReturn >= THRESHOLDS.STRONG_MOVE_1D_PCT &&
          return1d <= THRESHOLDS.REVERSAL_NEXT_DAY_PCT) {
        reversalAfterSpikeFlag = true;
      }
    }

    // ── Breakout followthrough: need window high to compare against ──
    let breakoutFollowthroughFlag: boolean | null = null;
    if (window.length >= 10) {
      const windowHigh = Math.max(...window.map((b) => b.high));
      if (bar.high > windowHigh && prev) {
        // Followthrough = next bar's close still above the breakout level.
        // We can only know this when we're looking at the NEXT bar — so
        // defer to null on the breakout day itself.
        breakoutFollowthroughFlag = null;
      } else if (i > 0) {
        const priorWindow = bars.slice(Math.max(0, i - 1 - lookback), i - 1);
        if (priorWindow.length >= 10) {
          const pHigh = Math.max(...priorWindow.map((b) => b.high));
          if (prev!.high > pHigh) {
            breakoutFollowthroughFlag = bar.close > pHigh;
          }
        }
      }
    }

    // Exhaustion: strong move + very high CLR or upper wick + next day hasn't come
    const exhaustionFlag =
      Math.abs(return1d) >= THRESHOLDS.STRONG_MOVE_1D_PCT &&
      (upperShadowPct >= THRESHOLDS.LONG_UPPER_SHADOW_PCT || closeLocationInRange <= 0.2);

    // ── Liquidity fragility ──────────────────────────────────────
    const priceImpactProxy = bar.volume > 0
      ? round4(Math.abs(return1d) / Math.log(1 + bar.volume))
      : 0;
    const metaAvgVol = meta.avgVolume20 ?? avgVolume20;
    const metaAvgTurn = meta.avgTurnover20 ?? avgTurnover20;
    const illiquidityRiskFlag =
      (metaAvgVol > 0 && metaAvgVol < THRESHOLDS.ILLIQUID_AVG_VOLUME) ||
      (metaAvgTurn != null && metaAvgTurn < THRESHOLDS.ILLIQUID_AVG_TURNOVER);

    // ── Composite patterns (need prior features, so compute inline) ──
    const recentFeatures = out.slice(Math.max(0, out.length - THRESHOLDS.CLUSTER_WINDOW));
    const recentLongUpperWicks = recentFeatures.filter(
      (f) => f.upperShadowPct >= THRESHOLDS.LONG_UPPER_SHADOW_PCT,
    ).length;
    const recentHighCLR = recentFeatures.filter(
      (f) => f.closeLocationInRange >= THRESHOLDS.CLOSE_RAMP_CLR_MIN,
    ).length;
    const recentAnomalies = recentFeatures.filter(
      (f) =>
        f.volumeVs20dAvg >= THRESHOLDS.HIGH_VOLUME_MULT ||
        f.abnormalRangeFlag ||
        f.reversalAfterSpikeFlag ||
        Math.abs(f.gapPct) >= THRESHOLDS.LARGE_GAP_PCT,
    ).length;

    const repeatedDistributionPattern = recentLongUpperWicks >= THRESHOLDS.DISTRIBUTION_REPETITION;
    const repeatedRampPattern = recentHighCLR >= THRESHOLDS.RAMP_REPETITION;
    const eventClusterCount = recentAnomalies;
    const anomalyDensity20d = round4(recentAnomalies / THRESHOLDS.CLUSTER_WINDOW);

    out.push({
      date: bar.date,
      symbol,
      // volume
      volumeVs20dAvg,
      turnoverVs20dAvg,
      streakOfHighVolumeDays,
      volumePriceDivergenceFlag,
      // candle
      bodyPctOfRange,
      upperShadowPct,
      lowerShadowPct,
      closeLocationInRange,
      gapPct,
      trueRangePct,
      abnormalRangeFlag,
      // price
      return1d,
      return3d,
      return5d,
      reversalAfterSpikeFlag,
      breakoutFollowthroughFlag,
      exhaustionFlag,
      // liquidity
      avgVolume20: round2(avgVolume20),
      avgTurnover20: avgTurnover20 != null ? round2(avgTurnover20) : null,
      priceImpactProxy,
      illiquidityRiskFlag,
      // composite
      repeatedRampPattern,
      repeatedDistributionPattern,
      eventClusterCount,
      anomalyDensity20d,
    });
  }

  return out;
}
