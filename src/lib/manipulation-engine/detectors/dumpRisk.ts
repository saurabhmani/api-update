// Detector: probable dump risk.
// Pattern: sharp drop after prior pump, heavy volume, close near low.
// Also catches lower-shadow absorption bars (repeated tails below) — a dump
// that is being caught, but also a distribution tell.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const dumpRiskDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const sharpDrop3d = current.return3d <= THRESHOLDS.DUMP_3D_PCT;
  const todayDump = current.return1d <= -THRESHOLDS.STRONG_MOVE_1D_PCT;
  const heavyVolume = current.volumeVs20dAvg >= THRESHOLDS.HIGH_VOLUME_MULT;
  const closeNearLow = current.closeLocationInRange <= 0.15;

  const window = history.slice(-THRESHOLDS.CLUSTER_WINDOW);
  const longLowerWicks = window.filter(
    (f) => f.lowerShadowPct >= THRESHOLDS.LONG_LOWER_SHADOW_PCT,
  ).length;
  const absorption = longLowerWicks >= THRESHOLDS.DISTRIBUTION_REPETITION;

  const signals = [sharpDrop3d, todayDump, heavyVolume && todayDump, closeNearLow, absorption];
  const hits = signals.filter(Boolean).length;
  const triggered = hits >= 2;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (hits >= 4) { severity = 'severe'; detectorScore = 90; }
    else if (hits === 3) { severity = 'high'; detectorScore = 72; }
    else { severity = 'medium'; detectorScore = 55; }
  }

  const eventType = absorption && !todayDump
    ? 'repeated_lower_shadow_absorption'
    : 'probable_dump_risk';

  return {
    detectorName: 'dumpRisk',
    eventType,
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? `Probable dump pattern — ${hits}/5 signals (suspected, not confirmed)`
      : 'No dump pattern',
    severity,
    confidence: triggered ? 0.55 + 0.1 * Math.max(0, hits - 2) : 0.15,
    evidence: [
      { key: 'return1d', value: current.return1d, description: 'Today return %' },
      { key: 'return3d', value: current.return3d, description: '3-day return %' },
      { key: 'volumeVs20dAvg', value: current.volumeVs20dAvg, description: 'Volume multiple' },
      { key: 'closeLocationInRange', value: current.closeLocationInRange, description: 'Close position in range' },
      { key: 'longLowerWickBars', value: longLowerWicks, description: 'Lower-shadow bars in window' },
      { key: 'signalsActive', value: hits, description: 'Number of dump signals triggered' },
    ],
  };
};
