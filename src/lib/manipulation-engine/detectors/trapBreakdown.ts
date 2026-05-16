// Detector: failed/trap breakdown — sharp support break that immediately
// reclaims. Mirror of trapBreakout. Engineered fear-flush trap.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const trapBreakdownDetector: DetectorFn = ({ history, barHistory }): DetectorResult => {
  if (barHistory.length < 12) return inert();

  const reclaimBar = barHistory[barHistory.length - 1];
  const breakdownBar = barHistory[barHistory.length - 2];
  const priorWindow = barHistory.slice(-12, -2);
  const priorLow = Math.min(...priorWindow.map((b) => b.low));

  const buffer = priorLow * (THRESHOLDS.TRAP_BREAKOUT_BUFFER_PCT / 100);
  const wasBreakdown = breakdownBar.low <= priorLow - buffer;
  if (!wasBreakdown) return inert();

  const breakdownFeature = history[history.length - 2];
  const wideRange = breakdownFeature ? breakdownFeature.trueRangePct >= 4 : false;
  const heavyVolume = breakdownFeature ? breakdownFeature.volumeVs20dAvg >= 2 : false;

  // Reclaim: next bar closes back above the prior support level.
  const reclaimed = reclaimBar.close > priorLow;
  const strongReclaim = reclaimBar.close > priorLow * (1 - THRESHOLDS.TRAP_REVERSAL_PCT / 100);

  const triggered = wasBreakdown && reclaimed && (wideRange || heavyVolume);

  let severity: DetectorResult['severity'] = 'low';
  let score = 0;
  if (triggered) {
    if (strongReclaim && heavyVolume && wideRange) { severity = 'severe'; score = 85; }
    else if (strongReclaim) { severity = 'high'; score = 70; }
    else { severity = 'medium'; score = 55; }
  }

  return {
    detectorName: 'trapBreakdown',
    eventType: 'range_expansion_without_followthrough',
    triggered,
    detectorScore: score,
    detectorLabel: triggered
      ? `Trap breakdown — support ${priorLow.toFixed(2)} reclaimed`
      : 'No trap breakdown',
    severity,
    confidence: triggered ? (strongReclaim ? 0.75 : 0.6) : 0.2,
    evidence: [
      { key: 'priorLow', value: priorLow, description: '10-bar low before breakdown' },
      { key: 'breakdownLow', value: breakdownBar.low, description: 'Breakdown bar low' },
      { key: 'reclaimClose', value: reclaimBar.close, description: 'Reclaim bar close' },
      { key: 'wideRange', value: wideRange, description: 'Breakdown bar TR ≥ 4%' },
      { key: 'heavyVolume', value: heavyVolume, description: 'Breakdown bar volume ≥ 2× avg' },
      { key: 'strongReclaim', value: strongReclaim, description: 'Reclaim ≥ 2% above level' },
    ],
  };
};

function inert(): DetectorResult {
  return {
    detectorName: 'trapBreakdown',
    eventType: 'range_expansion_without_followthrough',
    triggered: false,
    detectorScore: 0,
    detectorLabel: 'No trap breakdown',
    severity: 'low',
    confidence: 0.2,
    evidence: [],
  };
}
