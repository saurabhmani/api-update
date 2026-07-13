// ════════════════════════════════════════════════════════════════
//  Strategy Validation Engine (Phase 4)
//  Always validates against effective configuration (Phase 3 overrides).
// ════════════════════════════════════════════════════════════════

import { resolveEffectiveStrategyMode } from '@/lib/signal-engine/strategies/strategyModePolicy';
import { RISK_PROFILES, validateConfigurationPatch } from '../strategyParameterCatalog';
import { getEffectiveStrategyConfig } from '../effectiveStrategyConfig';
import { ACTIVE_RUNNER_STRATEGIES, getRegistryEntry } from '../registry';
import { loadStrategyProfile, upsertStrategyProfile } from '../repository/strategyProfiles';
import { extractModeOverride } from '../services/strategyModeOverrides';
import { resolveDeploymentLifecycle } from '../deploymentLifecycle';
import { loadStrategyMetrics } from './strategyMetricsService';
import { VALIDATION_THRESHOLDS, type ValidationDeployTarget } from '../validation/validationThresholds';
import {
  VALIDATION_CATEGORIES,
  type ValidationCategory,
  type ValidationCheck,
  type ValidationCheckStatus,
  type ValidationCategoryScore,
  type ValidationOverallStatus,
  type ValidationReport,
  type ValidationTarget,
} from '../validation/types';
import {
  listValidationHistory,
  loadLatestValidation,
  loadValidationReport,
  recordValidationHistory,
} from '../repository/validationHistory';

function check(
  partial: Omit<ValidationCheck, 'status'> & { status?: ValidationCheckStatus },
): ValidationCheck {
  return { status: partial.status ?? 'pass', ...partial } as ValidationCheck;
}

function scoreCategory(checks: ValidationCheck[], category: ValidationCategory): ValidationCategoryScore {
  const catChecks = checks.filter((c) => c.category === category);
  const passed = catChecks.filter((c) => c.status === 'pass').length;
  const warnings = catChecks.filter((c) => c.status === 'warning').length;
  const failed = catChecks.filter((c) => c.status === 'failure').length;
  const total = catChecks.length;
  const score = total === 0 ? 100 : Math.round(((passed + warnings * 0.5) / total) * 100);
  return { category, score, passed, warnings, failed, total };
}

function computeOverallStatus(checks: ValidationCheck[]): ValidationOverallStatus {
  if (checks.some((c) => c.required && c.status === 'failure')) return 'failed';
  if (checks.some((c) => c.status === 'failure' || c.status === 'warning')) return 'warning';
  return 'ready';
}

function computeOverallScore(categoryScores: ValidationCategoryScore[]): number {
  if (!categoryScores.length) return 0;
  return Math.round(categoryScores.reduce((sum, c) => sum + c.score, 0) / categoryScores.length);
}

export function isValidationApprovedForDeploy(
  report: ValidationReport,
  target: ValidationDeployTarget,
): boolean {
  if (report.checks.some((c) => c.required && c.status === 'failure')) return false;
  if (target === 'paper') {
    return report.overallStatus !== 'failed'
      && report.overallScore >= VALIDATION_THRESHOLDS.paper.minOverallScore;
  }
  return report.overallStatus === 'ready'
    && report.overallScore >= VALIDATION_THRESHOLDS.live.minOverallScore
    && report.liveDeployReady;
}

export async function runStrategyValidation(opts: {
  strategyId: string;
  target?: ValidationTarget;
}): Promise<ValidationReport> {
  const started = Date.now();
  const target = opts.target ?? 'assessment';
  const checks: ValidationCheck[] = [];
  const entry = getRegistryEntry(opts.strategyId);
  const configCtx = await getEffectiveStrategyConfig(opts.strategyId);
  const profile = await loadStrategyProfile(opts.strategyId);
  const modeOverride = extractModeOverride(profile?.metadata_json);

  if (!configCtx?.effective) {
    checks.push(check({
      id: 'cfg.effective', category: 'configuration', name: 'Effective configuration resolvable',
      status: 'failure', severity: 'critical', required: true,
      message: 'Could not resolve effective strategy configuration',
      recommendation: 'Verify strategy exists and profile metadata is valid',
    }));
  } else {
    checks.push(check({
      id: 'cfg.effective', category: 'configuration', name: 'Effective configuration resolvable',
      status: 'pass', severity: 'info', required: true,
      message: `Effective config loaded (v${configCtx.configVersion}, ${configCtx.overrideCount} overrides)`,
    }));
    const validation = validateConfigurationPatch(configCtx.effective as Record<string, unknown>);
    checks.push(check({
      id: 'cfg.params', category: 'configuration', name: 'Effective parameters valid',
      status: validation.valid ? 'pass' : 'failure', severity: validation.valid ? 'info' : 'high', required: true,
      message: validation.valid ? 'All effective parameters pass validation' : validation.issues.map((i) => i.message).join('; '),
      recommendation: validation.valid ? undefined : 'Fix invalid overrides in Strategy Configuration',
    }));
    const overlap = configCtx.effective.allowedRegimes.filter((r) =>
      configCtx.effective!.blockedRegimes.includes(r),
    );
    checks.push(check({
      id: 'cfg.regime_overlap', category: 'configuration', name: 'Regime allow/block consistency',
      status: overlap.length ? 'failure' : 'pass', severity: overlap.length ? 'high' : 'info', required: true,
      message: overlap.length ? `Overlapping regimes: ${overlap.join(', ')}` : 'Allowed and blocked regimes do not conflict',
    }));
    if (configCtx.overrideCount > 0) {
      checks.push(check({
        id: 'cfg.overrides', category: 'configuration', name: 'Admin overrides active',
        status: 'warning', severity: 'low', required: false,
        message: `${configCtx.overrideCount} parameter override(s) over registry defaults`,
      }));
    }
  }

  checks.push(check({
    id: 'int.registry', category: 'integrity', name: 'Strategy registered',
    status: entry ? 'pass' : 'failure', severity: entry ? 'info' : 'critical', required: true,
    message: entry ? 'Strategy exists in code registry' : 'Strategy not found in registry',
  }));

  const hasEvaluator = entry ? ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId) : false;
  checks.push(check({
    id: 'int.evaluator', category: 'integrity', name: 'Evaluator implemented',
    status: hasEvaluator ? 'pass' : 'failure', severity: hasEvaluator ? 'info' : 'critical', required: true,
    message: hasEvaluator ? 'Evaluator wired in runner' : 'No evaluator registered',
  }));
  checks.push(check({
    id: 'int.runner', category: 'integrity', name: 'Active in runner',
    status: hasEvaluator ? 'pass' : 'failure', severity: hasEvaluator ? 'info' : 'high', required: true,
    message: hasEvaluator ? 'Included in ACTIVE_RUNNER_STRATEGIES' : 'Not active in runner',
  }));

  const metadataComplete = !!(entry?.explanationTemplate && entry?.invalidationLogic && entry?.category && entry?.entryType);
  checks.push(check({
    id: 'int.metadata', category: 'integrity', name: 'Required metadata present',
    status: metadataComplete ? 'pass' : 'failure', severity: metadataComplete ? 'info' : 'high', required: true,
    message: metadataComplete ? 'Trade plan metadata complete' : 'Missing required metadata fields',
  }));

  const effectiveMode = entry
    ? resolveEffectiveStrategyMode(entry.strategyId, undefined, modeOverride ?? undefined)
    : 'DISABLED';
  checks.push(check({
    id: 'se.mode', category: 'signal_engine', name: 'Strategy mode allows execution',
    status: effectiveMode === 'DISABLED' ? 'failure' : effectiveMode === 'WATCHLIST_ONLY' ? 'warning' : 'pass',
    severity: effectiveMode === 'DISABLED' ? 'critical' : 'medium', required: true,
    message: `Effective mode: ${effectiveMode}`,
    recommendation: effectiveMode === 'DISABLED' ? 'Enable strategy before deployment' : undefined,
  }));
  checks.push(check({
    id: 'se.phase3', category: 'signal_engine', name: 'Phase 3 compatibility',
    status: hasEvaluator && effectiveMode !== 'DISABLED' ? 'pass' : 'failure',
    severity: 'high', required: true,
    message: hasEvaluator ? 'Can participate in Phase 3' : 'Cannot run in Phase 3 pipeline',
  }));

  const eff = configCtx?.effective;
  checks.push(check({
    id: 'risk.profile', category: 'risk', name: 'Effective risk profile',
    status: eff && RISK_PROFILES.includes(eff.riskProfile) ? 'pass' : 'failure',
    severity: 'high', required: true,
    message: eff ? `Risk profile: ${eff.riskProfile}` : 'Missing risk profile',
  }));
  const cw = eff?.defaultConfidenceWeight ?? 0;
  checks.push(check({
    id: 'risk.confidence_weight', category: 'risk', name: 'Confidence weight bounds',
    status: cw >= 0.1 && cw <= 2 ? 'pass' : 'failure', severity: 'medium', required: true,
    message: `Effective confidence weight: ${cw}`,
  }));

  const { detail: perf } = await loadStrategyMetrics(opts.strategyId, '90D');
  const t = target === 'live' ? VALIDATION_THRESHOLDS.live : VALIDATION_THRESHOLDS.paper;

  if (!perf || perf.performanceStatus === 'INSUFFICIENT_DATA') {
    checks.push(check({
      id: 'perf.sample', category: 'performance', name: 'Minimum trade sample',
      status: 'failure', severity: 'high', required: true,
      message: `Insufficient evaluated trades (need ≥ ${t.minEvaluatedTrades})`,
      recommendation: 'Accumulate more outcomes before deployment',
    }));
  } else {
    checks.push(check({
      id: 'perf.sample', category: 'performance', name: 'Minimum trade sample',
      status: perf.evaluatedSignals >= t.minEvaluatedTrades ? 'pass' : 'failure',
      severity: 'high', required: true,
      message: `${perf.evaluatedSignals} evaluated trades (${perf.performanceSource})`,
    }));
    checks.push(check({
      id: 'perf.win_rate', category: 'performance', name: 'Win rate threshold',
      status: perf.winRate >= t.minWinRate ? 'pass' : perf.winRate >= t.warnWinRate ? 'warning' : 'failure',
      severity: 'medium', required: target === 'live',
      message: `Win rate ${perf.winRate.toFixed(1)}% (min ${t.minWinRate}%)`,
    }));
    checks.push(check({
      id: 'perf.drawdown', category: 'performance', name: 'Max drawdown threshold',
      status: perf.maxDrawdownPct <= t.maxDrawdownPct ? 'pass' : 'failure',
      severity: 'high', required: true,
      message: `Max drawdown ${perf.maxDrawdownPct.toFixed(1)}% (max ${t.maxDrawdownPct}%)`,
    }));
    checks.push(check({
      id: 'perf.profit_factor', category: 'performance', name: 'Profit factor',
      status: perf.profitFactor >= t.minProfitFactor ? 'pass' : 'warning',
      severity: 'medium', required: false,
      message: `Profit factor ${perf.profitFactor.toFixed(2)}`,
    }));
    checks.push(check({
      id: 'perf.health', category: 'performance', name: 'Strategy health score',
      status: perf.strategyHealthScore >= t.minHealthScore ? 'pass' : 'warning',
      severity: 'medium', required: false,
      message: `Health ${perf.strategyHealthScore} — ${perf.healthLabel}`,
    }));
  }

  const lifecycle = resolveDeploymentLifecycle({
    storedStatus: profile?.deployment_status,
    readinessReady: hasEvaluator && metadataComplete,
    strategyModeDisabled: effectiveMode === 'DISABLED',
  });
  checks.push(check({
    id: 'dep.lifecycle', category: 'deployment', name: 'Deployment lifecycle state',
    status: lifecycle === 'disabled' ? 'failure' : 'pass', severity: 'high', required: true,
    message: `Lifecycle: ${lifecycle.replace(/_/g, ' ')}`,
  }));
  checks.push(check({
    id: 'dep.paper_gates', category: 'deployment', name: 'Paper trading prerequisites',
    status: hasEvaluator && effectiveMode !== 'DISABLED' ? 'pass' : 'failure',
    severity: 'high', required: true,
    message: 'Paper deployment prerequisites assessed',
  }));

  const categoryScores = VALIDATION_CATEGORIES.map((c) => scoreCategory(checks, c));
  const overallStatus = computeOverallStatus(checks);
  const overallScore = computeOverallScore(categoryScores);
  const passed = checks.filter((c) => c.status === 'pass').length;
  const warnings = checks.filter((c) => c.status === 'warning').length;
  const failed = checks.filter((c) => c.status === 'failure').length;

  const report: ValidationReport = {
    strategyId: opts.strategyId,
    displayName: entry?.displayName ?? opts.strategyId,
    target,
    overallStatus,
    overallScore,
    passPercentage: checks.length ? Math.round((passed / checks.length) * 100) : 0,
    categoryScores,
    checks,
    summary: {
      total: checks.length, passed, warnings, failed,
      executionTimeMs: Date.now() - started,
      validatedAt: new Date().toISOString(),
    },
    effectiveConfig: (configCtx?.effective ?? {}) as Record<string, unknown>,
    registryDefaults: (configCtx?.registryDefaults ?? {}) as Record<string, unknown>,
    configVersion: configCtx?.configVersion ?? 0,
    configOverrideCount: configCtx?.overrideCount ?? 0,
    paperDeployReady: false,
    liveDeployReady: false,
    blockedReasons: [],
  };

  report.paperDeployReady = isValidationApprovedForDeploy(report, 'paper');
  report.liveDeployReady = isValidationApprovedForDeploy(report, 'live');
  report.blockedReasons = checks.filter((c) => c.required && c.status === 'failure').map((c) => c.message);

  return report;
}

export async function validateAndPersistStrategy(opts: {
  strategyId: string;
  userId: number;
  actor: string;
  target?: ValidationTarget;
}): Promise<ValidationReport> {
  const report = await runStrategyValidation({ strategyId: opts.strategyId, target: opts.target ?? 'assessment' });
  const validationId = await recordValidationHistory({
    strategyId: opts.strategyId,
    userId: opts.userId,
    target: report.target,
    overallStatus: report.overallStatus,
    validationScore: report.overallScore,
    report,
    effectiveConfig: report.effectiveConfig,
    configVersion: report.configVersion,
    executionTimeMs: report.summary.executionTimeMs,
    actor: opts.actor,
  });
  report.validationId = validationId;

  if (report.paperDeployReady && report.overallStatus !== 'failed') {
    await upsertStrategyProfile(opts.strategyId, { deployment_status: 'validated' });
  }
  return report;
}

export async function assertStrategyValidationForDeploy(
  strategyId: string,
  target: ValidationDeployTarget,
): Promise<{ approved: boolean; report: ValidationReport; issues: string[] }> {
  const latest = await loadLatestValidation(strategyId);
  const report = latest?.report_json
    ? { ...latest.report_json, validationId: latest.id }
    : await runStrategyValidation({ strategyId, target: 'assessment' });

  const approved = isValidationApprovedForDeploy(report, target);
  const issues = approved ? [] : [
    ...report.blockedReasons,
    ...(report.overallScore < VALIDATION_THRESHOLDS[target].minOverallScore
      ? [`Score ${report.overallScore} below minimum ${VALIDATION_THRESHOLDS[target].minOverallScore}`] : []),
    'Run Validate Strategy and resolve failures before deploying',
  ];
  return { approved, report, issues: [...new Set(issues)] };
}

export { loadLatestValidation, loadValidationReport, listValidationHistory };
