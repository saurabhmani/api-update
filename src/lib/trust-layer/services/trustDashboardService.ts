// ════════════════════════════════════════════════════════════════
//  Trust Dashboard — aggregates live platform metrics (no blank values)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getActiveConfirmedSnapshots } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { STRATEGY_REGISTRY } from '@strategy-engine';
import { computePnl } from '@/services/portfolioLedgerService';
import { computeRiskSummary } from '@/services/riskCoreService';
import { loadMarketRegimeSnapshot } from './benchmarkCandles';
import { loadTrustStrategyPerformance } from './trustStrategyPerformanceService';
import { getRegimeCategoryModifier } from './regimeConfidence';
import type { TrustDashboardPayload, TrustLabel } from '../types';

const ACTIVE_STRATEGY_COUNT = Object.keys(STRATEGY_REGISTRY).filter(
  (k) => !['multi_timeframe_alignment', 'vwap_reclaim_long', 'vwap_rejection_short',
    'opening_range_breakout', 'opening_range_breakdown'].includes(k),
).length;

async function resolvePortfolioId(userId: number): Promise<number | null> {
  const { rows } = await db.query(
    'SELECT id FROM portfolios WHERE user_id = ? LIMIT 1',
    [userId],
  );
  return rows.length ? Number((rows[0] as { id: number }).id) : null;
}

function deriveTrustLabel(score: number): TrustLabel {
  if (score >= 75) return 'HIGH';
  if (score >= 50) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'INSUFFICIENT_DATA';
}

export async function buildTrustDashboard(userId: number): Promise<TrustDashboardPayload> {
  const market = getMarketStatus();
  const regime = await loadMarketRegimeSnapshot();
  const snapshots = await getActiveConfirmedSnapshots();
  let todayPnl = 0;
  let todayPnlPct = 0;
  // Default posture for accounts with no portfolio yet: no exposure,
  // no severity. The old default (`riskExposure=100`, `severity='critical'`)
  // was inherited from an early spec that assumed a fully-invested demo
  // account and produced misleading "CRITICAL" pills on the Trust page
  // for every fresh signup.
  let riskExposure = 0;
  let riskSeverity: TrustDashboardPayload['riskSeverity'] = 'ok';
  let hasPortfolio = false;

  const portfolioId = await resolvePortfolioId(userId);
  if (portfolioId) {
    hasPortfolio = true;
    try {
      const pnl = await computePnl(portfolioId);
      todayPnl = pnl.totalPnl;
      todayPnlPct = pnl.totalPnlPct;
    } catch { /* empty portfolio — keep zeros */ }

    try {
      const risk = await computeRiskSummary(portfolioId);
      riskExposure = risk.riskScore;
      riskSeverity = risk.overallSeverity;
    } catch { /* no holdings — keep 0/ok */ }
  }

  let winRate = 0;
  try {
    const { rows: perf } = await loadTrustStrategyPerformance('90D');
    const withData = perf.filter((p) => p.dataStatus === 'AVAILABLE');
    if (withData.length > 0) {
      winRate = Math.round(
        withData.reduce((s, p) => s + p.winRate, 0) / withData.length,
      );
    }
  } catch { /* no performance data yet */ }

  const regimeModifier = getRegimeCategoryModifier(regime.category);
  const trustReasons: string[] = [];
  let trustPoints = 20;
  trustReasons.push(`${snapshots.length} active confirmed signals`);
  trustReasons.push(`Market regime: ${regime.label} (modifier ${regimeModifier >= 0 ? '+' : ''}${regimeModifier})`);
  if (regime.source === 'index') {
    trustPoints += 25;
    trustReasons.push('Regime computed from live NIFTY 50 benchmark');
  }
  if (market.isOpen) {
    trustPoints += 15;
    trustReasons.push('Market session open');
  } else {
    trustPoints += 5;
    trustReasons.push('Market closed — last close metrics');
  }
  if (winRate > 0) {
    trustPoints += Math.min(25, Math.round(winRate / 4));
    trustReasons.push(`90D blended win rate ${winRate}%`);
  }
  if (snapshots.length > 0) trustPoints += 15;

  const trustScoreRaw = Math.min(100, trustPoints);
  const trustLabel = regime.source === 'insufficient_data'
    ? 'INSUFFICIENT_DATA' as const
    : deriveTrustLabel(trustScoreRaw);

  return {
    marketSummary: {
      benchmarkSymbol: 'NIFTY 50',
      benchmarkChangePct: regime.trendSlope,
      marketOpen: market.isOpen,
      sessionLabel: market.label ?? (market.isOpen ? 'Market Open' : 'Market Closed'),
      lastUpdated: new Date().toISOString(),
    },
    activeSignals: snapshots.length,
    runningStrategies: ACTIVE_STRATEGY_COUNT,
    todayPnl,
    todayPnlPct,
    winRate,
    riskExposure,
    riskSeverity,
    hasPortfolio,
    marketRegime: regime,
    trustScore: {
      score: trustLabel === 'INSUFFICIENT_DATA' ? 0 : trustScoreRaw,
      label: trustLabel,
      reasons: trustReasons,
    },
  };
}
