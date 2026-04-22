// Detector: repeated long-upper-shadow bars = distribution under the highs.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const upperWickDistributionDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const window = history.slice(-THRESHOLDS.CLUSTER_WINDOW);
  const longWicks = window.filter(
    (f) => f.upperShadowPct >= THRESHOLDS.LONG_UPPER_SHADOW_PCT,
  ).length;

  const triggered = longWicks >= THRESHOLDS.DISTRIBUTION_REPETITION || current.repeatedDistributionPattern;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (longWicks >= THRESHOLDS.DISTRIBUTION_REPETITION + 3) { severity = 'severe'; detectorScore = 80; }
    else if (longWicks >= THRESHOLDS.DISTRIBUTION_REPETITION + 1) { severity = 'high'; detectorScore = 65; }
    else { severity = 'medium'; detectorScore = 50; }
  }

  return {
    detectorName: 'upperWickDistribution',
    eventType: 'repeated_upper_shadow_distribution',
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? `Repeated distribution tails (${longWicks} in ${window.length} bars)`
      : 'No distribution pattern',
    severity,
    confidence: triggered ? 0.75 : 0.2,
    evidence: [
      { key: 'longUpperWickBars', value: longWicks, description: 'Long-upper-shadow bars in window' },
      { key: 'windowSize', value: window.length, description: 'Lookback window' },
      { key: 'currentUpperShadowPct', value: current.upperShadowPct, description: 'Today upper shadow %' },
    ],
  };
};
