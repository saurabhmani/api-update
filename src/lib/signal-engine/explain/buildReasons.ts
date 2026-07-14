// ════════════════════════════════════════════════════════════════
//  Reasons Generator — Phase 1 + Phase 2
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyName } from '../types/signalEngine.types';
import { round } from '../utils/math';
import { formatFibLevelDisplay, isPriceNearFibLevel } from '../indicators/fibonacci';

const FIB_REASON_TOLERANCE_PCT = 1;

export function buildReasons(features: SignalFeatures, strategy?: StrategyName): string[] {
  const { trend, momentum, volume, structure, context, volatility } = features;
  const reasons: string[] = [];

  // Strategy-specific lead reason
  if (strategy) {
    switch (strategy) {
      case 'bullish_breakout':
        if (structure.breakoutDistancePct > 0) {
          reasons.push(
            `Breakout: price closed ${round(structure.breakoutDistancePct, 1)}% above 20-day resistance at ${structure.recentResistance20}`,
          );
        }
        break;
      case 'momentum_continuation':
        reasons.push(
          `Momentum ride: ADX at ${round(momentum.adx)} confirms strong trend with RSI ${round(momentum.rsi14)} in power zone`,
        );
        break;
      case 'bullish_pullback':
        reasons.push(
          `Pullback entry: price ${round(trend.distanceFrom20EmaPct, 1)}% from 20 EMA in confirmed uptrend`,
        );
        break;
      case 'bearish_breakdown':
        reasons.push(
          `Breakdown: price closed below 20-day support at ${structure.recentSupport20}`,
        );
        break;
      case 'mean_reversion_bounce':
        reasons.push(
          `Oversold bounce: RSI at ${round(momentum.rsi14)} near 20-day support`,
        );
        break;
      case 'bullish_divergence':
        reasons.push(
          `Bullish divergence: price making lower lows but RSI making higher lows — momentum failure signaling reversal`,
        );
        break;
      case 'volume_climax_reversal':
        reasons.push(
          `Volume climax: ${round(volume.volumeClimaxRatio, 1)}x average volume with RSI at ${round(momentum.rsi14)} signals capitulation`,
        );
        break;
      case 'gap_continuation':
        reasons.push(
          `Gap & go: ${round(volatility.gapPct, 1)}% gap up with ${round(volume.volumeVs20dAvg, 1)}x volume in uptrend`,
        );
        break;
      case 'fibonacci_pullback': {
        const tol = structure.fibTolerancePct ?? FIB_REASON_TOLERANCE_PCT;
        const { fib382, fib50, fib618, fib786 } = structure;
        if (structure.fibSwingLow != null && structure.fibSwingHigh != null) {
          reasons.push(
            `Confirmed impulse anchors: swing low ${structure.fibSwingLow}` +
              `${structure.fibSwingLowTs ? ` (${structure.fibSwingLowTs.slice(0, 10)})` : ''}` +
              ` → swing high ${structure.fibSwingHigh}` +
              `${structure.fibSwingHighTs ? ` (${structure.fibSwingHighTs.slice(0, 10)})` : ''}`,
          );
        }
        reasons.push('Price is holding near a key Fibonacci retracement support zone.');
        if (structure.fibZoneQualityScore != null) {
          reasons.push(`Fibonacci zone quality ${structure.fibZoneQualityScore}/100 (tol ${tol}%)`);
        }
        if (trend.ema20Above50 && trend.closeAbove200Ema) {
          reasons.push('Fibonacci pullback is aligned with the bullish trend.');
        }
        const near382 = fib382 !== undefined && isPriceNearFibLevel(trend.close, fib382, tol);
        const near50 = fib50 !== undefined && isPriceNearFibLevel(trend.close, fib50, tol);
        const near618 = fib618 !== undefined && isPriceNearFibLevel(trend.close, fib618, tol);
        const near786 = fib786 !== undefined && isPriceNearFibLevel(trend.close, fib786, tol);
        if (near382 || near50 || near618 || near786) {
          const levelParts: string[] = [];
          if (near382) levelParts.push('38.2%');
          if (near50) levelParts.push('50%');
          if (near618) levelParts.push('61.8%');
          if (near786) levelParts.push('78.6%');
          reasons.push(
            `Active retracement ${levelParts.join(' / ')} with RSI ${round(momentum.rsi14)}`,
          );
        } else if (structure.fibNearestLevelName) {
          reasons.push(
            `Nearest Fibonacci level: ${formatFibLevelDisplay(structure.fibNearestLevelName)} at ${structure.fibNearestLevel}`,
          );
        }
        break;
      }
    }
  } else if (structure.breakoutDistancePct > 0) {
    reasons.push(
      `Price closed ${round(structure.breakoutDistancePct, 1)}% above 20-day resistance at ${structure.recentResistance20}`,
    );
  }

  // Volume expansion
  if (volume.volumeVs20dAvg >= 1.5) {
    reasons.push(
      `Volume expanded to ${round(volume.volumeVs20dAvg, 1)}x the 20-day average`,
    );
  }

  // Trend alignment
  if (trend.closeAbove20Ema && trend.closeAbove50Ema) {
    reasons.push('Stock is trading above both 20 EMA and 50 EMA');
  }
  if (trend.closeAbove200Ema) {
    reasons.push('Price remains above the 200-day moving average');
  }
  if (trend.ema20Above50 && trend.ema50Above200) {
    reasons.push('All key moving averages are positively aligned');
  }

  // Momentum
  if (momentum.macdHistogram > 0) {
    reasons.push('Momentum remains supportive with positive MACD histogram');
  }
  if (momentum.roc5 > 0 && momentum.roc20 > 0) {
    reasons.push('Short-term and medium-term rate of change are both positive');
  }

  // RSI in ideal range
  if (momentum.rsi14 >= 55 && momentum.rsi14 <= 72) {
    reasons.push(`RSI at ${round(momentum.rsi14)} is in the ideal range`);
  }

  // ADX confirmation
  if (momentum.adx >= 30) {
    reasons.push(`ADX at ${round(momentum.adx)} confirms strong trending conditions`);
  }

  // OBV confirmation
  if (volume.obvSlope > 5) {
    reasons.push('On-Balance Volume is rising — confirming accumulation');
  }

  // Regime
  if (context.marketRegime === 'Strong Bullish') {
    reasons.push('Broader market regime is strongly bullish');
  } else if (context.marketRegime === 'Bullish') {
    reasons.push('Broader market regime is bullish');
  }

  // Volume quality
  if (volume.breakoutVolumeRatio >= 1.0) {
    reasons.push('Breakout candle volume exceeds the recent 20-day peak');
  }

  // Bollinger squeeze breakout
  if (volatility.squeezed) {
    reasons.push('Volatility squeeze detected — potential for explosive move');
  }

  // Structure
  if (structure.consecutiveHigherLows >= 3) {
    reasons.push(`${structure.consecutiveHigherLows} consecutive higher lows — strong buying pressure`);
  }

  return reasons;
}
