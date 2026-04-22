// Detector: circular interest. Repeated surge/reversal cycles + high
// event density without institutional-quality follow-through. This is
// a META-detector — it summarises pattern repetition over time.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const circularInterestDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const window = history.slice(-THRESHOLDS.CLUSTER_WINDOW);
  const reversalCycles = window.filter((f) => f.reversalAfterSpikeFlag).length;
  const density = current.anomalyDensity20d;
  const distribution = current.repeatedDistributionPattern;
  const ramp = current.repeatedRampPattern;

  const triggered =
    density >= THRESHOLDS.CIRCULAR_EVENT_DENSITY &&
    reversalCycles >= THRESHOLDS.CIRCULAR_REVERSAL_CYCLES &&
    (distribution || ramp);

  let severity: DetectorResult['severity'] = 'low';
  let score = 0;
  if (triggered) {
    if (density >= 0.4 && reversalCycles >= 4) { severity = 'severe'; score = 85; }
    else if (density >= 0.3) { severity = 'high'; score = 70; }
    else { severity = 'medium'; score = 55; }
  }

  return {
    detectorName: 'circularInterest',
    eventType: 'circular_interest_suspected',
    triggered,
    detectorScore: score,
    detectorLabel: triggered
      ? `Circular-interest pattern — density ${(density * 100).toFixed(0)}%, ${reversalCycles} reversal cycles (suspected)`
      : 'No circular-interest pattern',
    severity,
    confidence: triggered ? 0.6 : 0.15,
    evidence: [
      { key: 'anomalyDensity20d', value: density, description: 'Anomaly density in last 20 bars' },
      { key: 'reversalCycles', value: reversalCycles, description: 'Reversal-after-spike bars in window' },
      { key: 'repeatedDistribution', value: distribution, description: 'Repeated distribution flag' },
      { key: 'repeatedRamp', value: ramp, description: 'Repeated ramp flag' },
    ],
  };
};
