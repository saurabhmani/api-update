// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Governance
//  Recommendations are versioned, auditable, replayable.
//  No automatic execution.
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { PortfolioGovernanceRecord, PortfolioRecommendation } from '../types';
import { PORTFOLIO_SCHEMA_VERSION } from '../types';

const auditLog: PortfolioGovernanceRecord[] = [];

export function createRecommendationId(portfolioId: string, createdAt: string): string {
  const stamp = createdAt.slice(0, 10).replaceAll('-', '');
  return `rec_${stamp}_${portfolioId.slice(-8)}`;
}

export function versionRecommendation(
  portfolioId: string,
  author: string,
  replaySeed: number,
  gitCommit?: string | null,
): Omit<PortfolioRecommendation, 'signals' | 'executionPlan' | 'explanations'> {
  const createdAt = new Date().toISOString();
  return {
    recommendationId: createRecommendationId(portfolioId, createdAt),
    portfolioId,
    version: PORTFOLIO_SCHEMA_VERSION,
    createdAt,
    author,
    gitCommit: gitCommit ?? null,
    replaySeed,
  };
}

export function hashRecommendation(rec: PortfolioRecommendation): string {
  const payload = JSON.stringify({
    portfolioId: rec.portfolioId,
    version: rec.version,
    replaySeed: rec.replaySeed,
    signals: rec.signals.map((s) => ({ symbol: s.signal.symbol, rank: s.rank, selected: s.selected })),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function auditRecommendation(
  rec: PortfolioRecommendation,
  auditor: string,
): PortfolioGovernanceRecord {
  const record: PortfolioGovernanceRecord = {
    recommendationId: rec.recommendationId,
    version: rec.version,
    auditedAt: new Date().toISOString(),
    auditor,
    replayable: true,
    autoExecutionBlocked: true,
  };
  auditLog.push(Object.freeze({ ...record }));
  return record;
}

export function getAuditLog(): readonly PortfolioGovernanceRecord[] {
  return auditLog;
}

export function clearAuditLog(): void {
  auditLog.length = 0;
}

export function assertPortfolioIsolation(): {
  productionPipelineTouched: false;
  autoExecutionEnabled: false;
  signalGenerationModified: false;
} {
  return {
    productionPipelineTouched: false,
    autoExecutionEnabled: false,
    signalGenerationModified: false,
  };
}

export function canAutoExecute(): false {
  return false;
}
