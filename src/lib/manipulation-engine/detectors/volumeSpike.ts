// Detector: abnormal volume/turnover spike.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const volumeSpikeDetector: DetectorFn = ({ current }): DetectorResult => {
  const vm = current.volumeVs20dAvg;
  const tm = current.turnoverVs20dAvg;

  const volumeTriggered = vm >= THRESHOLDS.HIGH_VOLUME_MULT;
  const turnoverTriggered = tm != null && tm >= THRESHOLDS.HIGH_TURNOVER_MULT;
  const triggered = volumeTriggered || turnoverTriggered;

  // Pick the dominant signal for the eventType.
  const eventType = turnoverTriggered && !volumeTriggered
    ? 'abnormal_turnover_spike'
    : 'abnormal_volume_spike';

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (vm >= THRESHOLDS.SEVERE_VOLUME_MULT) { severity = 'severe'; detectorScore = 90; }
  else if (vm >= THRESHOLDS.HIGH_VOLUME_MULT * 1.5) { severity = 'high'; detectorScore = 70; }
  else if (vm >= THRESHOLDS.HIGH_VOLUME_MULT) { severity = 'medium'; detectorScore = 50; }
  else if (turnoverTriggered) { severity = 'medium'; detectorScore = 45; }

  return {
    detectorName: 'volumeSpike',
    eventType,
    triggered,
    detectorScore: triggered ? detectorScore : 0,
    detectorLabel: triggered
      ? `Volume ${vm.toFixed(1)}× 20d avg (${severity})`
      : 'No volume anomaly',
    severity,
    confidence: triggered ? 0.8 : 0.2,
    evidence: [
      { key: 'volumeVs20dAvg', value: vm, description: 'Today volume / 20d average' },
      { key: 'streakOfHighVolumeDays', value: current.streakOfHighVolumeDays, description: 'Consecutive ≥2× avg days' },
      ...(tm != null ? [{ key: 'turnoverVs20dAvg', value: tm, description: 'Today turnover / 20d avg' }] : []),
    ],
  };
};
