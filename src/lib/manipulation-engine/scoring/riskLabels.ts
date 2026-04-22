// ════════════════════════════════════════════════════════════════
//  Risk Label Aggregation
//
//  Translates a set of triggered detector results into the
//  human-meaningful Phase 2 risk labels. The mapping is intentionally
//  many-to-many: e.g. a triggered pumpRisk + closeRamp both contribute
//  to "probable_pump_setup". All labels are *probabilistic* — daily
//  OHLCV cannot prove intent, so we never use confirmation language.
// ════════════════════════════════════════════════════════════════

import type { DetectorResult, RiskLabel } from '../types';

export function deriveRiskLabels(detectors: DetectorResult[]): RiskLabel[] {
  const triggered = detectors.filter((d) => d.triggered);
  const names = new Set(triggered.map((d) => d.detectorName));
  const labels = new Set<RiskLabel>();

  if (names.has('pumpRisk') || (names.has('volumeSpike') && names.has('closeRamp'))) {
    labels.add('probable_pump_setup');
  }
  if (names.has('dumpRisk')) {
    labels.add('probable_dump_setup');
  }
  if (names.has('upperWickDistribution')) {
    labels.add('probable_distribution');
  }
  if (names.has('closeRamp') || names.has('illiquidMarking')) {
    labels.add('probable_operator_activity');
  }
  if (names.has('trapBreakout')) {
    labels.add('possible_trap_breakout');
  }
  if (names.has('trapBreakdown')) {
    labels.add('possible_trap_breakdown');
  }
  if (names.has('washActivityProxy')) {
    labels.add('wash_proxy_observed');
    labels.add('suspicious_turnover_behavior');
  }
  if (names.has('spoofProxy')) {
    labels.add('spoof_proxy_observed');
  }

  return Array.from(labels);
}
