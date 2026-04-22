// ════════════════════════════════════════════════════════════════
//  Detector Registry — Phase 1 + Phase 2 detectors.
//
//  Order here affects nothing logically, but keeping the most
//  severity-relevant detectors first makes reading the
//  triggeredEvents array easier in dashboards.
// ════════════════════════════════════════════════════════════════

import type { DetectorFn } from '../types';
import { volumeSpikeDetector } from './volumeSpike';
import { reversalAfterSpikeDetector } from './reversalAfterSpike';
import { upperWickDistributionDetector } from './upperWickDistribution';
import { gapFadeDetector } from './gapFade';
import { illiquidMarkingDetector } from './illiquidMarking';
import { pumpRiskDetector } from './pumpRisk';
import { dumpRiskDetector } from './dumpRisk';
import { closeRampDetector } from './closeRamp';
import { trapBreakoutDetector } from './trapBreakout';
import { trapBreakdownDetector } from './trapBreakdown';
import { washActivityProxyDetector } from './washActivityProxy';
import { spoofProxyDetector } from './spoofProxy';
import { circularInterestDetector } from './circularInterest';
import { newsPumpDetector } from './newsPumpDetector';

export const ALL_DETECTORS: DetectorFn[] = [
  // Phase 1
  pumpRiskDetector,
  dumpRiskDetector,
  volumeSpikeDetector,
  reversalAfterSpikeDetector,
  upperWickDistributionDetector,
  gapFadeDetector,
  illiquidMarkingDetector,
  // Phase 2
  closeRampDetector,
  trapBreakoutDetector,
  trapBreakdownDetector,
  washActivityProxyDetector,
  spoofProxyDetector,
  circularInterestDetector,
  // Phase 3 — News intelligence
  newsPumpDetector,
];

export {
  volumeSpikeDetector,
  reversalAfterSpikeDetector,
  upperWickDistributionDetector,
  gapFadeDetector,
  illiquidMarkingDetector,
  pumpRiskDetector,
  dumpRiskDetector,
  closeRampDetector,
  trapBreakoutDetector,
  trapBreakdownDetector,
  washActivityProxyDetector,
  spoofProxyDetector,
  circularInterestDetector,
  newsPumpDetector,
};
