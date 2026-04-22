// Detector: price spike followed by immediate reversal / gap-and-fade.
import type { DetectorFn, DetectorResult } from '../types';
import { THRESHOLDS } from '../constants/thresholds';

export const reversalAfterSpikeDetector: DetectorFn = ({ current, history }): DetectorResult => {
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const prevReturn = prev?.return1d ?? 0;
  const prevUpperWick = prev?.upperShadowPct ?? 0;
  const prevGap = prev?.gapPct ?? 0;

  const hadSpike = prevReturn >= THRESHOLDS.STRONG_MOVE_1D_PCT ||
                   prevGap >= THRESHOLDS.LARGE_GAP_PCT ||
                   prevUpperWick >= THRESHOLDS.LONG_UPPER_SHADOW_PCT;
  const reversedHard = current.return1d <= THRESHOLDS.REVERSAL_NEXT_DAY_PCT;
  const gapAndFade = current.gapPct >= THRESHOLDS.LARGE_GAP_PCT && current.closeLocationInRange <= 0.25;

  const triggered = (hadSpike && reversedHard) || gapAndFade || current.reversalAfterSpikeFlag;

  let severity: DetectorResult['severity'] = 'low';
  let detectorScore = 0;
  if (triggered) {
    if (Math.abs(current.return1d) >= THRESHOLDS.SEVERE_MOVE_1D_PCT) { severity = 'severe'; detectorScore = 85; }
    else if (Math.abs(current.return1d) >= THRESHOLDS.STRONG_MOVE_1D_PCT) { severity = 'high'; detectorScore = 70; }
    else { severity = 'medium'; detectorScore = 55; }
  }

  const eventType = gapAndFade
    ? 'suspicious_opening_gap_fade'
    : hadSpike
      ? 'range_expansion_without_followthrough'
      : 'suspicious_opening_gap_fade';

  return {
    detectorName: 'reversalAfterSpike',
    eventType,
    triggered,
    detectorScore,
    detectorLabel: triggered
      ? 'Reversal / fade following prior expansion'
      : 'No reversal detected',
    severity,
    confidence: triggered ? 0.7 : 0.2,
    evidence: [
      { key: 'prevReturn1d', value: prevReturn, description: 'Prior bar return %' },
      { key: 'todayReturn1d', value: current.return1d, description: 'Today return %' },
      { key: 'gapPct', value: current.gapPct, description: 'Open vs prev close gap %' },
      { key: 'closeLocationInRange', value: current.closeLocationInRange, description: 'Where close sat in day range' },
    ],
  };
};
