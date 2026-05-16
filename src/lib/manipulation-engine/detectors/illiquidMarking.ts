// Detector: low-liquidity price marking.
// Signature pattern: meaningful price move on LOW volume in an illiquid name,
// often with a closing ramp (high CLR). Very common for operator-driven
// price marking at quarter/month end.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const illiquidMarkingDetector: DetectorFn = ({ current, meta }): DetectorResult => {
  const avgTurn = meta.avgTurnover20 ?? current.avgTurnover20;
  const avgVol = meta.avgVolume20 ?? current.avgVolume20;

  const illiquid =
    (avgVol > 0 && avgVol < THRESHOLDS.ILLIQUID_AVG_VOLUME) ||
    (avgTurn != null && avgTurn > 0 && avgTurn < THRESHOLDS.ILLIQUID_AVG_TURNOVER) ||
    current.illiquidityRiskFlag;

  const meaningfulMove = Math.abs(current.return1d) >= THRESHOLDS.MARKING_MIN_RETURN_PCT;
  const lowVolumeForMove = current.volumeVs20dAvg <= THRESHOLDS.MARKING_MAX_VOLUME_MULT;
  const closeRamped = current.closeLocationInRange >= THRESHOLDS.CLOSE_RAMP_CLR_MIN;

  const triggered = illiquid && meaningfulMove && lowVolumeForMove && (closeRamped || current.return1d > 0);

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (Math.abs(current.return1d) >= THRESHOLDS.SEVERE_MOVE_1D_PCT) { severity = 'severe'; detectorScore = 85; }
    else if (closeRamped) { severity = 'high'; detectorScore = 70; }
    else { severity = 'medium'; detectorScore = 55; }
  }

  return {
    detectorName: 'illiquidMarking',
    eventType: closeRamped ? 'suspicious_close_ramping' : 'illiquid_price_marking',
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? `Probable price marking in illiquid name (${current.return1d.toFixed(1)}% on ${current.volumeVs20dAvg.toFixed(1)}× avg vol)`
      : 'No marking pattern',
    severity,
    confidence: triggered ? 0.65 : 0.2,  // probabilistic — OHLCV alone can't confirm
    evidence: [
      { key: 'avgVolume20', value: avgVol, description: '20d average volume' },
      { key: 'avgTurnover20', value: avgTurn ?? 0, description: '20d average turnover' },
      { key: 'return1d', value: current.return1d, description: 'Day return %' },
      { key: 'volumeVs20dAvg', value: current.volumeVs20dAvg, description: 'Volume multiple of avg' },
      { key: 'closeLocationInRange', value: current.closeLocationInRange, description: 'Close ramping indicator' },
    ],
  };
};
