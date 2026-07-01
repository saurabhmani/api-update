// ════════════════════════════════════════════════════════════════
//  postScanSummary — canonical post-scan funnel + rejection histogram.
//
//  Emitted once per scan via [POST_SCAN_SUMMARY] (JSON) and
//  [POST_SCAN_STRATEGY] (per-strategy lines). Use these metrics
//  before tuning any thresholds.
// ════════════════════════════════════════════════════════════════

import type { DiscoveryGateCounters } from '../discovery/signalDiscoveryStatus';
import type { StrategyScanStats } from './strategyScanHistogram';
import { snapshotStrategyScanHistogram } from './strategyScanHistogram';

export interface PostScanStageCounts {
  universeTotal:            number;
  candlesValid:             number;
  featuresValid:            number;
  strategyMatched:          number;
  tradePlanOk:              number;
  generatedCandidates:      number;
  confirmedSignals:         number;
  highPotential:            number;
  developingSetup:          number;
  watchlistOnly:            number;
  noTrade:                  number;
  rejectedByStrategyMode:   number;
  rejectedByFinalScore:       number;
  rejectedByDataQuality:      number;
  portfolioBlocked:         number;
  positionSizingInvalid:    number;
  signalsSaved:             number;
}

export interface PostScanSummary extends PostScanStageCounts {
  generatedAt:    string;
  generationSource: string;
  regime:         string;
  scanned:        number;
  approved:       number;
  deferred:       number;
  rejected:       number;
  strategies:     StrategyScanStats[];
}

export interface BuildPostScanSummaryInput {
  generationSource:       string;
  regime:                 string;
  universeTotal:          number;
  stageReached: {
    candle_valid:    number;
    features_valid:  number;
    strategy_match:  number;
    trade_plan_ok:   number;
    decision_stage:  number;
  };
  generatedCandidates:    number;
  discoveryGateCounters:  DiscoveryGateCounters;
  rejectionHistogram: {
    noTrade:                  number;
    rejectedByStrategyMode:   number;
    rejectedByFinalScore:     number;
    rejectedByDataQuality:    number;
  };
  scanCounters: {
    scanned:   number;
    approved:  number;
    deferred:  number;
    rejected:  number;
  };
  signalsSaved?:          number;
}

export function buildPostScanSummary(input: BuildPostScanSummaryInput): PostScanSummary {
  const d = input.discoveryGateCounters;
  const r = input.rejectionHistogram;
  return {
    generatedAt:      new Date().toISOString(),
    generationSource: input.generationSource,
    regime:           input.regime,
    universeTotal:    input.universeTotal,
    candlesValid:     input.stageReached.candle_valid,
    featuresValid:    input.stageReached.features_valid,
    strategyMatched:  input.stageReached.strategy_match,
    tradePlanOk:      input.stageReached.trade_plan_ok,
    generatedCandidates: input.generatedCandidates,
    confirmedSignals: d.confirmedSignals,
    highPotential:    d.highPotential,
    developingSetup:  d.developingSetup,
    watchlistOnly:    d.watchlistOnly,
    noTrade:          r.noTrade,
    rejectedByStrategyMode: r.rejectedByStrategyMode,
    rejectedByFinalScore:   r.rejectedByFinalScore,
    rejectedByDataQuality:  r.rejectedByDataQuality,
    portfolioBlocked:       d.portfolioBlocked,
    positionSizingInvalid:  d.positionSizingInvalid,
    signalsSaved:           input.signalsSaved ?? input.generatedCandidates,
    scanned:    input.scanCounters.scanned,
    approved:   input.scanCounters.approved,
    deferred:   input.scanCounters.deferred,
    rejected:   input.scanCounters.rejected,
    strategies: snapshotStrategyScanHistogram(),
  };
}

/** Greppable single-line funnel + JSON block for log shippers. */
export function logPostScanSummary(summary: PostScanSummary): void {
  const line = [
    `universeTotal=${summary.universeTotal}`,
    `candlesValid=${summary.candlesValid}`,
    `featuresValid=${summary.featuresValid}`,
    `strategyMatched=${summary.strategyMatched}`,
    `tradePlanOk=${summary.tradePlanOk}`,
    `generatedCandidates=${summary.generatedCandidates}`,
    `confirmedSignals=${summary.confirmedSignals}`,
    `highPotential=${summary.highPotential}`,
    `developingSetup=${summary.developingSetup}`,
    `watchlistOnly=${summary.watchlistOnly}`,
    `noTrade=${summary.noTrade}`,
    `rejectedByStrategyMode=${summary.rejectedByStrategyMode}`,
    `rejectedByFinalScore=${summary.rejectedByFinalScore}`,
    `rejectedByDataQuality=${summary.rejectedByDataQuality}`,
    `portfolioBlocked=${summary.portfolioBlocked}`,
    `positionSizingInvalid=${summary.positionSizingInvalid}`,
    `signalsSaved=${summary.signalsSaved}`,
    `source=${summary.generationSource}`,
    `regime=${summary.regime}`,
  ].join(' ');

  console.log(`[POST_SCAN_SUMMARY] ${line}`);
  console.log('[POST_SCAN_SUMMARY_JSON]', JSON.stringify(summary));

  for (const s of summary.strategies) {
    console.log(
      `[POST_SCAN_STRATEGY] strategy=${s.strategy} ` +
      `evaluated=${s.evaluated} matched=${s.matched} ` +
      `confirmed=${s.confirmed} watchlist=${s.watchlist} rejected=${s.rejected} ` +
      `avgFinalScore=${s.averageFinalScore ?? 'null'} ` +
      `topRejection=${s.topRejectionReason ?? 'none'}`,
    );
  }
}
