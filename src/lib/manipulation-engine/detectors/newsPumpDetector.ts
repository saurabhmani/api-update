// ════════════════════════════════════════════════════════════════
//  News Pump / Dump Detector — Phase 3 Manipulation Engine
//
//  Boosts manipulation suspicion score when news intelligence
//  suggests social hype, coordinated pump patterns, or
//  suspicious news-driven volume.
//
//  Signals:
//    1. Social amplification + volume spike = pump risk
//    2. Hyperbolic news language + thin body = pump/dump setup
//    3. Low-trust source burst + price surge = coordinated pump
//    4. Negative sentiment + high volume = potential dump
//
//  RULES:
//    - Override confidence via PENALTY ONLY (never boost)
//    - This detector ADDS to suspicion — never reduces it
//    - Evidence must be auditable
// ════════════════════════════════════════════════════════════════

import type { DetectorFn, DetectorInput, DetectorResult, DetectorEvidence, Severity } from '../types';

const DETECTOR_NAME = 'news_pump_dump_detector';

/**
 * News-based manipulation detector.
 *
 * Since DetectorInput doesn't carry news data directly (it's OHLCV-based),
 * this detector checks for price/volume patterns that CORRELATE with
 * news-driven pump/dump behavior:
 *
 *   1. Abnormal volume + large price move + high upper wick = distribution after pump news
 *   2. Multi-day volume streak + parabolic move = pump in progress
 *   3. Gap up + high volume + reversal = buy-the-news dump
 *   4. Compressed range breakout + volume explosion = potential news-driven trap
 *
 * The actual news scores are incorporated at the signal-engine level
 * via the SymbolImpact.manipulationRiskBoost field. This detector
 * catches the PRICE-SIDE evidence that news-driven manipulation
 * would produce.
 */
export const newsPumpDetector: DetectorFn = (input: DetectorInput): DetectorResult => {
  const { current, currentBar, barHistory, meta } = input;
  const evidence: DetectorEvidence[] = [];
  let score = 0;
  let severity: Severity = 'low';
  let triggered = false;

  // ── Signal 1: Volume spike + upper wick distribution ───────
  // Classic pump pattern: news drives buying → insiders distribute
  // via upper wick. Volume > 3x avg + upper wick > 40% of range.
  if (current.volumeVs20dAvg >= 3.0 && current.upperShadowPct > 0.40) {
    const priceGain = current.return1d;
    if (priceGain > 0) {
      // Price up but heavy upper wick = distribution after pump
      score += 30;
      triggered = true;
      evidence.push({
        key: 'volume_spike_with_distribution',
        value: `vol=${current.volumeVs20dAvg.toFixed(1)}x, wick=${(current.upperShadowPct * 100).toFixed(0)}%`,
        description: 'High volume with large upper shadow suggests distribution after news-driven buying',
      });
    }
  }

  // ── Signal 2: Multi-day volume streak + parabolic move ─────
  // Sustained pump: 3+ days of high volume with compounding returns.
  if (current.streakOfHighVolumeDays >= 3) {
    const compoundReturn = current.return3d;
    if (compoundReturn > 8) {
      score += 25;
      triggered = true;
      severity = 'medium';
      evidence.push({
        key: 'sustained_pump_pattern',
        value: `streak=${current.streakOfHighVolumeDays}d, return3d=${compoundReturn.toFixed(1)}%`,
        description: 'Sustained high-volume buying streak with parabolic price movement — pump pattern',
      });
    }
  }

  // ── Signal 3: Gap up + volume + reversal = news dump ───────
  // "Buy the rumor, sell the news" pattern: gap up on news,
  // then close near low = institutional exit.
  if (current.gapPct > 2.0 && current.volumeVs20dAvg >= 2.0) {
    if (current.closeLocationInRange < 0.30) {
      score += 35;
      triggered = true;
      severity = 'high';
      evidence.push({
        key: 'news_gap_dump',
        value: `gap=${current.gapPct.toFixed(1)}%, close_loc=${(current.closeLocationInRange * 100).toFixed(0)}%`,
        description: 'Gap up on high volume but closed near low — "sell the news" distribution pattern',
      });
    }
  }

  // ── Signal 4: Range breakout + volume explosion + weak follow-through ──
  // News-driven trap breakout: price breaks out with volume but
  // immediately reverses — suggests coordinated pump to trap longs.
  if (current.volumeVs20dAvg >= 2.5 && current.abnormalRangeFlag) {
    if (current.reversalAfterSpikeFlag) {
      score += 30;
      triggered = true;
      severity = severity === 'high' ? 'severe' : 'high';
      evidence.push({
        key: 'news_trap_breakout',
        value: `vol=${current.volumeVs20dAvg.toFixed(1)}x, reversal=true`,
        description: 'Volume explosion with immediate reversal — potential news-driven trap',
      });
    }
  }

  // ── Signal 5: Volume-price divergence on high volume ───────
  // High volume + flat/negative return = informed selling into buying pressure
  if (current.volumePriceDivergenceFlag && current.volumeVs20dAvg >= 2.0) {
    score += 15;
    if (!triggered) triggered = true;
    evidence.push({
      key: 'volume_price_divergence',
      value: `vol=${current.volumeVs20dAvg.toFixed(1)}x, divergence=true`,
      description: 'High volume with flat/negative return — potential distribution under news cover',
    });
  }

  // ── Severity escalation ────────────────────────────────────
  if (score >= 60) severity = 'severe';
  else if (score >= 40) severity = 'high';
  else if (score >= 20) severity = 'medium';

  // Confidence: higher when multiple signals corroborate
  const signalCount = evidence.length;
  const confidence = Math.min(0.95, 0.4 + signalCount * 0.15);

  return {
    detectorName: DETECTOR_NAME,
    eventType: score >= 40 ? 'probable_pump_risk' : 'abnormal_volume_spike',
    triggered,
    detectorScore: Math.min(100, score),
    detectorLabel: triggered
      ? `News-correlated pump/dump pattern (${evidence.length} signals)`
      : 'No news-driven manipulation pattern detected',
    severity,
    confidence,
    evidence,
  };
};
