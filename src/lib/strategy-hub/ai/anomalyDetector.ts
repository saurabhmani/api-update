// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — anomaly detection (Phase 7)
//
//  Splits the strategy's outcome history into a recent slice and a
//  baseline slice, then flags statistically meaningful divergence.
//  Every anomaly carries the metrics that triggered it.
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import { computeSimulationMetrics, isEvaluatedRow, mean, round1 } from './aiMath';
import type { AiAnomaly } from './types';

const RECENT_DAYS = 14;
const MIN_BASELINE_TRADES = 6;
const MIN_RECENT_TRADES = 3;

function splitRows(rows: PerformanceOutcomeRow[]): {
  recent: PerformanceOutcomeRow[];
  baseline: PerformanceOutcomeRow[];
} {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recent: PerformanceOutcomeRow[] = [];
  const baseline: PerformanceOutcomeRow[] = [];
  for (const row of rows) {
    if ((row.evaluatedAt ?? '') >= cutoff) recent.push(row);
    else baseline.push(row);
  }
  return { recent, baseline };
}

function dominantRegime(rows: PerformanceOutcomeRow[]): { regime: string; share: number } | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const regime = String(row.regime ?? '').trim();
    if (!regime) continue;
    counts.set(regime, (counts.get(regime) ?? 0) + 1);
    total += 1;
  }
  if (!total) return null;
  let best: { regime: string; share: number } | null = null;
  for (const [regime, count] of counts) {
    const share = count / total;
    if (!best || share > best.share) best = { regime, share };
  }
  return best;
}

export function detectAnomalies(
  strategyId: string,
  rows: PerformanceOutcomeRow[],
  opts: { window: string; pipelineSignals?: number },
): AiAnomaly[] {
  const anomalies: AiAnomaly[] = [];
  const now = new Date().toISOString();
  const { recent, baseline } = splitRows(rows);
  const recentEval = recent.filter(isEvaluatedRow);
  const baselineEval = baseline.filter(isEvaluatedRow);

  const push = (a: Omit<AiAnomaly, 'strategyId' | 'detectedAt'>) =>
    anomalies.push({ ...a, strategyId, detectedAt: now });

  // ── Inactivity / missing signals ─────────────────────────────
  if (baseline.length >= MIN_BASELINE_TRADES && recent.length === 0) {
    push({
      id: `${strategyId}:inactivity`,
      type: 'inactivity',
      severity: 'warning',
      title: 'Strategy activity stopped',
      rootCause: `The strategy produced ${baseline.length} outcomes earlier in the ${opts.window} window but none in the last ${RECENT_DAYS} days.`,
      suggestedAction: 'Check the strategy mode, scheduler status, and signal-engine filters for this strategy.',
      metrics: { baselineOutcomes: baseline.length, recentOutcomes: 0, recentDays: RECENT_DAYS },
    });
    return anomalies; // Without recent data, comparative checks are moot.
  }

  if (baselineEval.length < MIN_BASELINE_TRADES || recentEval.length < MIN_RECENT_TRADES) {
    return anomalies;
  }

  const recentM = computeSimulationMetrics(recent);
  const baseM = computeSimulationMetrics(baseline);

  // ── Sudden win-rate drop ─────────────────────────────────────
  const wrDrop = baseM.winRate - recentM.winRate;
  if (wrDrop >= 20) {
    push({
      id: `${strategyId}:win_rate_drop`,
      type: 'win_rate_drop',
      severity: wrDrop >= 35 ? 'critical' : 'warning',
      title: `Win rate dropped ${round1(wrDrop)} pts`,
      rootCause: `Recent win rate ${recentM.winRate}% (${recentM.trades} trades) vs baseline ${baseM.winRate}% (${baseM.trades} trades).`,
      suggestedAction: 'Review the recent losing trades for a common regime, sector, or confidence pattern before adjusting parameters.',
      metrics: { recentWinRate: recentM.winRate, baselineWinRate: baseM.winRate, recentTrades: recentM.trades },
    });
  }

  // ── Approval rate collapse ───────────────────────────────────
  const approvalShare = (list: PerformanceOutcomeRow[]) => {
    const known = list.filter((r) => r.approvalStatus !== 'UNKNOWN');
    if (!known.length) return null;
    return (known.filter((r) => r.approvalStatus === 'APPROVED').length / known.length) * 100;
  };
  const recentApproval = approvalShare(recent);
  const baseApproval = approvalShare(baseline);
  if (recentApproval != null && baseApproval != null && baseApproval >= 30
      && recentApproval < baseApproval * 0.5) {
    push({
      id: `${strategyId}:approval_collapse`,
      type: 'approval_collapse',
      severity: 'warning',
      title: 'Approval rate collapsed',
      rootCause: `Approval share fell from ${round1(baseApproval)}% to ${round1(recentApproval)}% in the last ${RECENT_DAYS} days.`,
      suggestedAction: 'Inspect the review-engine rejections; the market may have shifted away from this strategy\'s ideal conditions.',
      metrics: { recentApprovalPct: round1(recentApproval), baselineApprovalPct: round1(baseApproval) },
    });
  }

  // ── Confidence anomaly ───────────────────────────────────────
  const recentConf = mean(recent.map((r) => r.confidenceScore).filter((c): c is number => c != null));
  const baseConf = mean(baseline.map((r) => r.confidenceScore).filter((c): c is number => c != null));
  if (recentConf != null && baseConf != null && Math.abs(recentConf - baseConf) >= 12) {
    const direction = recentConf < baseConf ? 'dropped' : 'jumped';
    push({
      id: `${strategyId}:confidence_anomaly`,
      type: 'confidence_anomaly',
      severity: recentConf < baseConf ? 'warning' : 'info',
      title: `Average confidence ${direction} ${round1(Math.abs(recentConf - baseConf))} pts`,
      rootCause: `Recent average confidence ${round1(recentConf)} vs baseline ${round1(baseConf)}.`,
      suggestedAction: recentConf < baseConf
        ? 'Falling conviction usually precedes performance decay — verify the confidence engine inputs.'
        : 'A sudden confidence jump can indicate an input distribution change — verify scoring inputs are healthy.',
      metrics: { recentConfidence: round1(recentConf), baselineConfidence: round1(baseConf) },
    });
  }

  // ── Unexpected drawdown ──────────────────────────────────────
  if (recentM.maxDrawdownPct >= 8 && recentM.maxDrawdownPct > baseM.maxDrawdownPct * 1.5) {
    push({
      id: `${strategyId}:drawdown_spike`,
      type: 'drawdown_spike',
      severity: recentM.maxDrawdownPct >= 15 ? 'critical' : 'warning',
      title: `Drawdown spike: ${recentM.maxDrawdownPct}%`,
      rootCause: `Recent drawdown ${recentM.maxDrawdownPct}% vs baseline ${baseM.maxDrawdownPct}% — losses are clustering.`,
      suggestedAction: 'Consider pausing new entries (Watchlist mode) until the losing streak is understood.',
      metrics: { recentDrawdownPct: recentM.maxDrawdownPct, baselineDrawdownPct: baseM.maxDrawdownPct },
    });
  }

  // ── Regime behaviour change ──────────────────────────────────
  const recentRegime = dominantRegime(recent);
  const baseRegime = dominantRegime(baseline);
  if (recentRegime && baseRegime && recentRegime.regime !== baseRegime.regime
      && recentRegime.share >= 0.5 && recentM.winRate < 45) {
    push({
      id: `${strategyId}:regime_shift`,
      type: 'regime_shift',
      severity: 'info',
      title: `Market regime shifted to "${recentRegime.regime}"`,
      rootCause: `Dominant regime moved from "${baseRegime.regime}" to "${recentRegime.regime}" (${Math.round(recentRegime.share * 100)}% of recent signals) while the recent win rate is ${recentM.winRate}%.`,
      suggestedAction: `Check whether "${recentRegime.regime}" is inside this strategy's historically profitable regimes.`,
      metrics: { recentRegime: recentRegime.regime, baselineRegime: baseRegime.regime, recentWinRate: recentM.winRate },
    });
  }

  // ── Execution anomaly (stop-hit clustering) ──────────────────
  const stopShare = (list: PerformanceOutcomeRow[]) => {
    const evaluated = list.filter(isEvaluatedRow);
    if (!evaluated.length) return null;
    return (evaluated.filter((r) => r.stopHit).length / evaluated.length) * 100;
  };
  const recentStops = stopShare(recent);
  const baseStops = stopShare(baseline);
  if (recentStops != null && baseStops != null && recentStops >= baseStops + 25 && recentStops >= 50) {
    push({
      id: `${strategyId}:execution_anomaly`,
      type: 'execution_anomaly',
      severity: 'warning',
      title: 'Stop-hit rate spiked',
      rootCause: `${round1(recentStops)}% of recent trades hit their stop vs ${round1(baseStops)}% in the baseline — entries may be poorly timed or stops too tight for current volatility.`,
      suggestedAction: 'Review stop placement against recent volatility (ATR) before taking new signals.',
      metrics: { recentStopHitPct: round1(recentStops), baselineStopHitPct: round1(baseStops) },
    });
  }

  return anomalies;
}
