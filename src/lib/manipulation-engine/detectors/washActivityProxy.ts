// Detector: wash-activity proxy. High turnover repeatedly producing
// little net price progress is a STATISTICAL fingerprint of churning,
// not a confirmation. We label it "proxy" so downstream UI can avoid
// implying confirmed wash trading.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const washActivityProxyDetector: DetectorFn = ({ history }): DetectorResult => {
  const window = history.slice(-THRESHOLDS.CLUSTER_WINDOW);
  if (window.length === 0) return inert();

  const lowProgressBars = window.filter((f) => {
    const heavyTurnover = (f.turnoverVs20dAvg ?? f.volumeVs20dAvg) >= THRESHOLDS.WASH_TURNOVER_MULT;
    const flat = Math.abs(f.return1d) <= THRESHOLDS.WASH_MAX_PROGRESS_PCT;
    return heavyTurnover && flat;
  }).length;

  const triggered = lowProgressBars >= THRESHOLDS.WASH_REPETITION;

  let severity: DetectorResult['severity'] = 'low';
  let score = 0;
  if (triggered) {
    if (lowProgressBars >= 6) { severity = 'severe'; score = 80; }
    else if (lowProgressBars >= 4) { severity = 'high'; score = 65; }
    else { severity = 'medium'; score = 50; }
  }

  return {
    detectorName: 'washActivityProxy',
    eventType: 'circular_interest_suspected',
    triggered,
    detectorScore: score,
    detectorLabel: triggered
      ? `Wash-activity proxy — ${lowProgressBars} high-turnover/low-progress bars (proxy, not confirmed)`
      : 'No wash-activity proxy',
    severity,
    confidence: triggered ? 0.55 : 0.15,
    evidence: [
      { key: 'lowProgressBars', value: lowProgressBars, description: 'Bars with ≥2× turnover and ≤1% net move' },
      { key: 'window', value: window.length, description: 'Lookback window' },
    ],
  };
};

function inert(): DetectorResult {
  return {
    detectorName: 'washActivityProxy',
    eventType: 'circular_interest_suspected',
    triggered: false,
    detectorScore: 0,
    detectorLabel: 'No wash-activity proxy',
    severity: 'low',
    confidence: 0.15,
    evidence: [],
  };
}
