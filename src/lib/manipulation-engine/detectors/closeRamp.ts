// Detector: repeated near-high closes — operator-style "close ramping".
// Suspicion rises if the same name closes in the top of its range for
// several sessions running, especially when the float is illiquid.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const closeRampDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const window = history.slice(-THRESHOLDS.CLOSE_RAMP_WINDOW);
  const rampCloses = window.filter(
    (f) => f.closeLocationInRange >= THRESHOLDS.CLOSE_RAMP_CLR_MIN,
  ).length;

  const triggered = rampCloses >= THRESHOLDS.CLOSE_RAMP_REPETITION;
  const illiquid = current.illiquidityRiskFlag;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (rampCloses >= 5 && illiquid) { severity = 'severe'; detectorScore = 85; }
    else if (rampCloses >= 4 || illiquid) { severity = 'high'; detectorScore = 70; }
    else { severity = 'medium'; detectorScore = 55; }
  }

  return {
    detectorName: 'closeRamp',
    eventType: 'suspicious_close_ramping',
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? `Repeated near-high closes (${rampCloses}/${window.length})${illiquid ? ' in illiquid name' : ''}`
      : 'No close-ramp pattern',
    severity,
    confidence: triggered ? (illiquid ? 0.75 : 0.6) : 0.2,
    evidence: [
      { key: 'rampCloses', value: rampCloses, description: 'Bars closing in top 15% of range' },
      { key: 'window', value: window.length, description: 'Lookback window size' },
      { key: 'illiquidityRiskFlag', value: illiquid, description: 'Symbol flagged illiquid' },
    ],
  };
};
