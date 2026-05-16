// Detector: probable pump risk.
// Pump pattern: sustained upward ramp + volume expansion + close ramping.
// Explicitly probabilistic — daily OHLCV alone cannot prove intent.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const pumpRiskDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const strongWeek = current.return5d >= THRESHOLDS.PUMP_3D_PCT;
  const strong3d = current.return3d >= THRESHOLDS.PUMP_3D_PCT;
  const volumeExpansion = current.volumeVs20dAvg >= THRESHOLDS.HIGH_VOLUME_MULT ||
                          current.streakOfHighVolumeDays >= THRESHOLDS.HIGH_VOLUME_STREAK_FOR_FLAG;
  const repeatedRamp = current.repeatedRampPattern;
  const rampingClose = current.closeLocationInRange >= THRESHOLDS.CLOSE_RAMP_CLR_MIN;

  // Require at least two of the four signals to fire.
  const signals = [strong3d || strongWeek, volumeExpansion, repeatedRamp, rampingClose];
  const hits = signals.filter(Boolean).length;
  const triggered = hits >= 2;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (hits >= 4) { severity = 'severe'; detectorScore = 90; }
    else if (hits === 3) { severity = 'high'; detectorScore = 75; }
    else { severity = 'medium'; detectorScore = 55; }
  }

  return {
    detectorName: 'pumpRisk',
    eventType: hits >= 3 ? 'probable_pump_risk' : 'operator_style_price_lifting',
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? `Probable pump pattern — ${hits}/4 signals active (suspected, not confirmed)`
      : 'No pump pattern',
    severity,
    confidence: triggered ? 0.55 + 0.1 * (hits - 2) : 0.15,
    evidence: [
      { key: 'return3d', value: current.return3d, description: '3-day cumulative return %' },
      { key: 'return5d', value: current.return5d, description: '5-day cumulative return %' },
      { key: 'volumeVs20dAvg', value: current.volumeVs20dAvg, description: 'Volume multiple' },
      { key: 'repeatedRampPattern', value: current.repeatedRampPattern, description: 'High-CLR bars in window ≥ threshold' },
      { key: 'closeLocationInRange', value: current.closeLocationInRange, description: 'Ramping close indicator' },
      { key: 'signalsActive', value: hits, description: 'Number of pump signals triggered' },
    ],
  };
};
