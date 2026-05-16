// Detector: failed/trap breakout. A wide-range, high-volume breakout
// candle with NO followthrough — reverses below the breakout level
// within 1 bar. Classic engineered-supply trap signature.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const trapBreakoutDetector: DetectorFn = ({ current, history, barHistory }): DetectorResult => {
  // Need at least 12 bars: 10 for the prior range + the breakout bar + the reversal bar.
  if (barHistory.length < 12) return inert();

  const reversalBar = barHistory[barHistory.length - 1];
  const breakoutBar = barHistory[barHistory.length - 2];
  const priorWindow = barHistory.slice(-12, -2);
  const priorHigh = Math.max(...priorWindow.map((b) => b.high));

  const buffer = priorHigh * (THRESHOLDS.TRAP_BREAKOUT_BUFFER_PCT / 100);
  const wasBreakout = breakoutBar.high >= priorHigh + buffer;
  if (!wasBreakout) return inert();

  // Volume / range expansion on the breakout bar.
  const breakoutFeature = history[history.length - 2];
  const wideRange = breakoutFeature ? breakoutFeature.trueRangePct >= 4 : false;
  const heavyVolume = breakoutFeature ? breakoutFeature.volumeVs20dAvg >= 2 : false;

  // Failure: reversal bar closes back below the prior high.
  const failed = reversalBar.close < priorHigh;
  // Strong failure: closes well below.
  const strongFail = reversalBar.close < priorHigh * (1 + THRESHOLDS.TRAP_REVERSAL_PCT / 100);

  const triggered = wasBreakout && failed && (wideRange || heavyVolume);

  let severity: DetectorResult['severity'] = 'low';
  let score = 0;
  if (triggered) {
    if (strongFail && heavyVolume && wideRange) { severity = 'severe'; score = 85; }
    else if (strongFail) { severity = 'high'; score = 70; }
    else { severity = 'medium'; score = 55; }
  }

  return {
    detectorName: 'trapBreakout',
    eventType: 'range_expansion_without_followthrough',
    triggered,
    detectorScore: score,
    detectorLabel: triggered
      ? `Trap breakout — failed continuation past ${priorHigh.toFixed(2)}`
      : 'No trap breakout',
    severity,
    confidence: triggered ? (strongFail ? 0.75 : 0.6) : 0.2,
    evidence: [
      { key: 'priorHigh', value: priorHigh, description: '10-bar high before breakout' },
      { key: 'breakoutHigh', value: breakoutBar.high, description: 'Breakout bar high' },
      { key: 'reversalClose', value: reversalBar.close, description: 'Reversal bar close' },
      { key: 'wideRange', value: wideRange, description: 'Breakout bar TR ≥ 4%' },
      { key: 'heavyVolume', value: heavyVolume, description: 'Breakout bar volume ≥ 2× avg' },
      { key: 'strongFailure', value: strongFail, description: 'Reversal close ≥ 2% below level' },
    ],
  };
};

function inert(): DetectorResult {
  return {
    detectorName: 'trapBreakout',
    eventType: 'range_expansion_without_followthrough',
    triggered: false,
    detectorScore: 0,
    detectorLabel: 'No trap breakout',
    severity: 'low',
    confidence: 0.2,
    evidence: [],
  };
}
