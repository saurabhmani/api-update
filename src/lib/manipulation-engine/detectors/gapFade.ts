// Detector: abnormal gap behavior — gap up/down with immediate fade.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const gapFadeDetector: DetectorFn = ({ current }): DetectorResult => {
  const absGap = Math.abs(current.gapPct);
  const largeGap = absGap >= THRESHOLDS.LARGE_GAP_PCT;

  // Gap up then close in bottom half = fade; gap down then close in top half = trap.
  const gapUpFaded = current.gapPct >= THRESHOLDS.LARGE_GAP_PCT && current.closeLocationInRange <= 0.35;
  const gapDownTrap = current.gapPct <= -THRESHOLDS.LARGE_GAP_PCT && current.closeLocationInRange >= 0.65;

  const triggered = gapUpFaded || gapDownTrap;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (absGap >= THRESHOLDS.LARGE_GAP_PCT * 2) { severity = 'high'; detectorScore = 70; }
    else { severity = 'medium'; detectorScore = 50; }
  }

  return {
    detectorName: 'gapFade',
    eventType: 'abnormal_gap_behavior',
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? (gapUpFaded ? 'Gap up faded into close' : 'Gap down reclaimed into close')
      : 'Normal gap behavior',
    severity,
    confidence: triggered ? 0.7 : (largeGap ? 0.4 : 0.2),
    evidence: [
      { key: 'gapPct', value: current.gapPct, description: 'Open vs prev close gap %' },
      { key: 'closeLocationInRange', value: current.closeLocationInRange, description: 'Close position in range' },
      { key: 'return1d', value: current.return1d, description: 'Day return %' },
    ],
  };
};
