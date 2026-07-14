// ════════════════════════════════════════════════════════════════
//  Phase 7 — Strategy version approval gates
//
//  Do NOT approve on win rate alone. Failing robustness → Restricted
//  (blocks elite publication via Phase 6 health).
// ════════════════════════════════════════════════════════════════

import type { StrategyName } from '../../signal-engine/types/signalEngine.types';
import {
  assessStrategyHealth,
  getLatestStrategyHealth,
  setStrategyHealthManual,
  type StrategyHealthSnapshot,
} from '../../signal-engine/governance/strategyHealth';
import type { BaselineCompareReport } from '../robustness/baselineComparison';
import type { RobustnessReport } from '../robustness/robustnessSuite';
import type { LeakageAudit } from '../bias/leakageGuards';
import type { FrozenCalibrationArtifact } from '../types';

export const STRATEGY_APPROVAL_VERSION = '7.0.0';

export interface ApprovalThresholds {
  minOosExpectancyR: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
  minSampleSize: number;
  minConsistencyScore: number;
  /** Elite 78% target reporting requires CI + n. */
  elitePrecisionTarget: number;
}

export const DEFAULT_APPROVAL_THRESHOLDS: ApprovalThresholds = {
  minOosExpectancyR: 0.05,
  minProfitFactor: 1.15,
  maxDrawdownPct: 25,
  minSampleSize: 40,
  minConsistencyScore: 40,
  elitePrecisionTarget: 0.78,
};

export interface StrategyVersionApprovalInput {
  strategy: StrategyName;
  strategyVersion: string;
  /** Headline metrics — MUST be OOS-only. */
  oosExpectancyR: number;
  oosProfitFactor: number;
  oosMaxDrawdownPct: number;
  oosSampleSize: number;
  oosWinRate: number;
  walkForwardConsistencyScore: number;
  /** Concentration: share of PnL from top year/sector/symbol (0–1). */
  maxConcentrationShare: number;
  calibrationAcceptable: boolean;
  leakageAudit: LeakageAudit;
  robustness: RobustnessReport;
  baselines?: BaselineCompareReport | null;
  frozenConfigs: FrozenCalibrationArtifact[];
  reproducibility: {
    codeVersion: string;
    configVersion: string;
    dataVersion: string;
  };
  /** Optional elite precision with CI (when reported). */
  elitePrecision?: {
    hitRate: number;
    sampleSize: number;
    ciLow: number;
    ciHigh: number;
  } | null;
  thresholds?: Partial<ApprovalThresholds>;
}

export interface StrategyVersionApprovalReport {
  modelVersion: string;
  strategy: StrategyName;
  strategyVersion: string;
  approved: boolean;
  /** Reasons — never win-rate-only. */
  gates: Array<{ id: string; passed: boolean; detail: string }>;
  healthAction: 'none' | 'restrict_elite' | 'restricted';
  healthSnapshot: StrategyHealthSnapshot | null;
  eliteReporting: {
    reported: boolean;
    hitRate: number | null;
    sampleSize: number | null;
    ciLow: number | null;
    ciHigh: number | null;
    meets78Target: boolean | null;
  };
  generatedAt: string;
}

export function evaluateStrategyVersionApproval(
  input: StrategyVersionApprovalInput,
): StrategyVersionApprovalReport {
  const thr = { ...DEFAULT_APPROVAL_THRESHOLDS, ...input.thresholds };
  const gates: StrategyVersionApprovalReport['gates'] = [];

  const g = (id: string, passed: boolean, detail: string) => gates.push({ id, passed, detail });

  g(
    'oos_expectancy',
    input.oosExpectancyR >= thr.minOosExpectancyR,
    `OOS expectancyR ${input.oosExpectancyR} (floor ${thr.minOosExpectancyR})`,
  );
  g(
    'profit_factor',
    input.oosProfitFactor >= thr.minProfitFactor,
    `OOS PF ${input.oosProfitFactor} (floor ${thr.minProfitFactor})`,
  );
  g(
    'drawdown',
    input.oosMaxDrawdownPct <= thr.maxDrawdownPct,
    `OOS max DD ${input.oosMaxDrawdownPct}% (ceiling ${thr.maxDrawdownPct}%)`,
  );
  g(
    'sample_size',
    input.oosSampleSize >= thr.minSampleSize,
    `OOS n=${input.oosSampleSize} (min ${thr.minSampleSize})`,
  );
  g(
    'not_winrate_only',
    true,
    `Win rate ${input.oosWinRate} recorded but NOT used as sole approval criterion`,
  );
  g(
    'concentration',
    input.maxConcentrationShare <= 0.55,
    `Max year/sector/symbol concentration ${(input.maxConcentrationShare * 100).toFixed(0)}%`,
  );
  g(
    'calibration',
    input.calibrationAcceptable,
    input.calibrationAcceptable ? 'Calibration acceptable' : 'Calibration not acceptable',
  );
  g(
    'leakage',
    input.leakageAudit.clean,
    input.leakageAudit.clean
      ? 'No unresolved data-leakage errors'
      : `Leakage errors: ${input.leakageAudit.findings.filter((f) => f.severity === 'error').map((f) => f.code).join(', ')}`,
  );
  g(
    'robustness',
    input.robustness.overallPass,
    input.robustness.overallPass
      ? 'Robustness suite passed'
      : 'Robustness suite failed — edge destroyed under stress',
  );
  g(
    'param_perturbation',
    !input.robustness.stresses.some(
      (s) => s.name === 'param_perturb_+5conf' && s.n >= 15 && s.expectancyR < -0.05,
    ),
    'Parameter perturbation must not destroy the edge',
  );
  g(
    'wf_consistency',
    input.walkForwardConsistencyScore >= thr.minConsistencyScore,
    `WF consistency ${input.walkForwardConsistencyScore} (min ${thr.minConsistencyScore})`,
  );
  g(
    'reproducibility',
    Boolean(input.reproducibility.codeVersion && input.reproducibility.configVersion && input.reproducibility.dataVersion),
    'Code, config, and data versions present',
  );
  g(
    'frozen_configs',
    input.frozenConfigs.length > 0,
    `${input.frozenConfigs.length} frozen IS calibration artefact(s)`,
  );

  if (input.baselines?.candidateBeatsRandom === false) {
    g('beats_random', false, 'Candidate does not beat random-entry control on expectancyR');
  } else if (input.baselines?.candidateBeatsRandom === true) {
    g('beats_random', true, 'Candidate beats random-entry control');
  }

  const approved = gates.filter((x) => x.id !== 'not_winrate_only').every((x) => x.passed);

  let healthAction: StrategyVersionApprovalReport['healthAction'] = 'none';
  let healthSnapshot: StrategyHealthSnapshot | null = null;

  if (!approved) {
    const prev = getLatestStrategyHealth(input.strategy);
    if (!input.robustness.overallPass || !input.leakageAudit.clean) {
      healthSnapshot = setStrategyHealthManual(
        input.strategy,
        'Restricted',
        `Phase 7 approval failed — auto-restrict elite publication (${gates.filter((x) => !x.passed).map((x) => x.id).join(', ')})`,
        prev,
      );
      healthAction = 'restricted';
    } else {
      healthSnapshot = assessStrategyHealth(
        {
          strategy: input.strategy,
          sampleSize: input.oosSampleSize,
          winRate: input.oosWinRate,
          avgPnlR: input.oosExpectancyR,
          calibrationDeteriorated: !input.calibrationAcceptable,
          sampleQualityPoor: input.oosSampleSize < thr.minSampleSize,
        },
        prev,
      );
      if (healthSnapshot.state === 'Restricted' || healthSnapshot.state === 'Watch') {
        healthAction = 'restrict_elite';
      }
    }
  }

  const elite = input.elitePrecision ?? null;
  const eliteReporting = {
    reported: elite != null,
    hitRate: elite?.hitRate ?? null,
    sampleSize: elite?.sampleSize ?? null,
    ciLow: elite?.ciLow ?? null,
    ciHigh: elite?.ciHigh ?? null,
    meets78Target:
      elite == null
        ? null
        : elite.hitRate >= thr.elitePrecisionTarget
          && elite.sampleSize >= thr.minSampleSize
          && elite.ciLow >= thr.elitePrecisionTarget - 0.08,
  };

  return {
    modelVersion: STRATEGY_APPROVAL_VERSION,
    strategy: input.strategy,
    strategyVersion: input.strategyVersion,
    approved,
    gates,
    healthAction,
    healthSnapshot,
    eliteReporting,
    generatedAt: new Date().toISOString(),
  };
}
