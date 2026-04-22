// ════════════════════════════════════════════════════════════════
//  Pre-Trade Risk Gateway — Phase 4
//
//  Mandatory evaluation before any trade becomes actionable.
//  A strong signal is NOT permission.
//
//  Decision states:
//    approved | approved_with_reduced_size | rejected | manual_review
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { computeExposure, computeConcentration, computeLiquidity, computeDrawdown, type RiskMetric } from './riskCoreService';
import { getHoldings } from './portfolioLedgerService';
import { resolveById } from './instrumentResolver';
import { assertOrchestratorContext } from './decisionContext';

const log = logger.child({ service: 'preTradeGateway' });

// ── Types ───────────────────────────────────────────────────────

export type PreTradeDecision = 'approved' | 'approved_with_reduced_size' | 'rejected' | 'manual_review';

export interface MonitoringBreachContext {
  category: string;
  severity: string;
  metric: string;
  message: string;
}

export interface PreTradeInput {
  portfolioId: number;
  instrumentId: number;           // canonical identity — REQUIRED
  ticker?: string;                // display hint only — resolved internally if omitted
  side: 'buy' | 'sell';
  quantity: number;
  price?: number;
  notional?: number;
  strategySleeve?: string;
  activeBreaches?: MonitoringBreachContext[];
}

export interface PreTradeBreach {
  check: string;
  severity: 'hard' | 'soft';
  message: string;
  current: number;
  limit: number;
}

export interface PreTradeResult {
  status: PreTradeDecision;
  riskScore: number;
  breaches: PreTradeBreach[];
  warnings: string[];
  recommendedQuantity: number;
  explanation: string;
  metricsSnapshot: RiskMetric[];
}

// ── Configurable Limits ─────────────────────────────────────────

interface Limits {
  maxSinglePositionPct: number;  // % of portfolio
  maxSectorExposurePct: number;
  maxConcentrationPct: number;   // top-1 after trade
  maxGrossExposure: number;      // in absolute terms (0 = unlimited)
  maxDrawdownPct: number;
  minLiquidityDaysToExit: number;
  maxPositions: number;
}

async function loadLimits(): Promise<Limits> {
  // Try system_thresholds, fall back to defaults
  const defaults: Limits = {
    maxSinglePositionPct: 20,
    maxSectorExposurePct: 30,
    maxConcentrationPct: 25,
    maxGrossExposure: 0,
    maxDrawdownPct: 15,
    minLiquidityDaysToExit: 10,
    maxPositions: 15,
  };

  try {
    const { rows } = await db.query(
      "SELECT config_key, config_value FROM system_thresholds WHERE config_key IN ('MAX_SINGLE_POSITION_PCT','MAX_SECTOR_EXPOSURE_PCT','MAX_DRAWDOWN_BLOCK','MAX_POSITIONS')",
    );
    for (const r of rows as any[]) {
      const val = Number(r.config_value);
      if (r.config_key === 'MAX_SINGLE_POSITION_PCT') defaults.maxSinglePositionPct = val;
      if (r.config_key === 'MAX_SECTOR_EXPOSURE_PCT') defaults.maxSectorExposurePct = val;
      if (r.config_key === 'MAX_DRAWDOWN_BLOCK') defaults.maxDrawdownPct = val;
      if (r.config_key === 'MAX_POSITIONS') defaults.maxPositions = val;
    }
  } catch {}

  return defaults;
}

// ── Risk Gate ───────────────────────────────────────────────────

export async function evaluatePreTrade(input: PreTradeInput): Promise<PreTradeResult> {
  // ── BYPASS GUARD: must be called from within orchestrator ────
  assertOrchestratorContext('evaluatePreTrade');

  const { portfolioId, instrumentId, side, quantity } = input;
  const price = input.price ?? 0;
  const notional = input.notional ?? quantity * price;
  const limits = await loadLimits();
  const breaches: PreTradeBreach[] = [];
  const warnings: string[] = [];
  let recommendedQuantity = quantity;

  // Resolve canonical identity — instrumentId is the primary key
  const instRef = await resolveById(instrumentId);
  const ticker = instRef?.ticker ?? input.ticker ?? '';
  const sector = instRef?.sector ?? 'Other';

  // Fetch current portfolio state
  const [holdings, exposure, concentration, liquidity, drawdown] = await Promise.all([
    getHoldings(portfolioId),
    computeExposure(portfolioId),
    computeConcentration(portfolioId),
    computeLiquidity(portfolioId),
    computeDrawdown(portfolioId),
  ]);

  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0) || 1;

  // ── Check 1: Position count ─────────────────────────────────
  if (side === 'buy' && holdings.length >= limits.maxPositions) {
    breaches.push({
      check: 'max_positions',
      severity: 'hard',
      message: `Portfolio already has ${holdings.length} positions (max: ${limits.maxPositions})`,
      current: holdings.length,
      limit: limits.maxPositions,
    });
  }

  // ── Check 2: Single-position max size ───────────────────────
  if (side === 'buy' && price > 0) {
    const postTradeWeight = (notional / (totalValue + notional)) * 100;
    if (postTradeWeight > limits.maxSinglePositionPct) {
      // Soft breach — can be resized
      const maxNotional = (limits.maxSinglePositionPct / 100) * totalValue / (1 - limits.maxSinglePositionPct / 100);
      const maxQty = price > 0 ? Math.floor(maxNotional / price) : quantity;
      recommendedQuantity = Math.min(recommendedQuantity, maxQty);
      breaches.push({
        check: 'single_position_size',
        severity: 'soft',
        message: `Trade would create ${postTradeWeight.toFixed(1)}% position (max: ${limits.maxSinglePositionPct}%)`,
        current: postTradeWeight,
        limit: limits.maxSinglePositionPct,
      });
    }
  }

  // ── Check 3: Sector exposure ────────────────────────────────
  if (side === 'buy') {
    // Sector resolved from instrumentId at function entry
    const currentSectorExposure = exposure.sectorExposures.find((s) => s.sector === sector);
    const currentPct = currentSectorExposure?.weight ?? 0;
    const addedPct = (notional / (totalValue + notional)) * 100;
    const projectedPct = currentPct + addedPct;

    if (projectedPct > limits.maxSectorExposurePct) {
      breaches.push({
        check: 'sector_exposure',
        severity: 'soft',
        message: `${sector} sector would reach ${projectedPct.toFixed(1)}% (max: ${limits.maxSectorExposurePct}%)`,
        current: projectedPct,
        limit: limits.maxSectorExposurePct,
      });
    }
  }

  // ── Check 4: Concentration impact ──────────────────────────
  if (side === 'buy' && price > 0) {
    const existing = holdings.find((h) => h.instrumentId === instrumentId || h.ticker === ticker);
    const existingVal = existing?.marketValue ?? 0;
    const postVal = existingVal + notional;
    const postWeight = (postVal / (totalValue + notional)) * 100;
    if (postWeight > limits.maxConcentrationPct) {
      breaches.push({
        check: 'concentration_impact',
        severity: 'soft',
        message: `${ticker} would be ${postWeight.toFixed(1)}% of portfolio (max: ${limits.maxConcentrationPct}%)`,
        current: postWeight,
        limit: limits.maxConcentrationPct,
      });
    }
  }

  // ── Check 5: Drawdown check ─────────────────────────────────
  if (drawdown.currentDrawdown > limits.maxDrawdownPct) {
    breaches.push({
      check: 'drawdown_block',
      severity: 'hard',
      message: `Portfolio in ${drawdown.currentDrawdown}% drawdown (max: ${limits.maxDrawdownPct}%) — new buys blocked`,
      current: drawdown.currentDrawdown,
      limit: limits.maxDrawdownPct,
    });
  }

  // ── Check 6: Liquidity threshold ────────────────────────────
  const tickerLiquidity = liquidity.holdings.find((h) => h.ticker === ticker);
  if (tickerLiquidity && tickerLiquidity.daysToExit > limits.minLiquidityDaysToExit) {
    warnings.push(`${ticker} has low liquidity — estimated ${tickerLiquidity.daysToExit} days to exit`);
  }

  // ── Check 7: Active monitoring breach amplification ────────
  // Monitoring alerts are NOT passive — they feed into risk evaluation.
  // When monitoring has already flagged a risk condition, the risk gate
  // must acknowledge and amplify rather than re-discover independently.
  const monitoringBreaches = input.activeBreaches ?? [];
  const riskRelatedBreaches = monitoringBreaches.filter(
    b => b.category === 'risk_breach' || b.category === 'concentration_breach' || b.category === 'liquidity_deterioration',
  );
  for (const mb of riskRelatedBreaches) {
    // Check if this monitoring finding overlaps with an existing risk check.
    // Overlapping = monitoring and risk gate both flagged the same condition.
    // Non-overlapping = monitoring found something the risk gate missed.
    const alreadyCaptured = breaches.some(b => b.check === mb.metric || mb.metric.includes(b.check));
    if (!alreadyCaptured) {
      // Monitoring found a risk condition the risk gate didn't flag — inject it
      breaches.push({
        check: `monitoring:${mb.metric}`,
        severity: mb.severity === 'critical' ? 'hard' : 'soft',
        message: `[monitoring] ${mb.message}`,
        current: 0,
        limit: 0,
      });
    }
    // Always amplify warnings with monitoring context
    warnings.push(`[monitoring] ${mb.category}: ${mb.message}`);
  }

  // ── Determine decision ──────────────────────────────────────
  const hardBreaches = breaches.filter((b) => b.severity === 'hard');
  const softBreaches = breaches.filter((b) => b.severity === 'soft');

  let status: PreTradeDecision;
  if (hardBreaches.length > 0) {
    status = 'rejected';
  } else if (softBreaches.length > 0 && recommendedQuantity < quantity) {
    status = 'approved_with_reduced_size';
  } else if (softBreaches.length > 0) {
    status = 'manual_review';
  } else {
    status = 'approved';
  }

  // Risk score
  let riskScore = 0;
  for (const b of breaches) {
    riskScore += b.severity === 'hard' ? 40 : 15;
  }
  riskScore += warnings.length * 5;
  riskScore = Math.min(100, riskScore);

  // Collect all metrics
  const metricsSnapshot = [
    ...exposure.metrics,
    ...concentration.metrics,
    ...drawdown.metrics,
  ];

  // Build explanation
  const explanationParts: string[] = [];
  if (status === 'approved') explanationParts.push('Trade passes all risk checks.');
  if (status === 'approved_with_reduced_size') {
    explanationParts.push(`Trade approved with reduced size: ${recommendedQuantity} shares (requested ${quantity}).`);
  }
  if (status === 'rejected') {
    explanationParts.push('Trade rejected due to hard limit breaches.');
    for (const b of hardBreaches) explanationParts.push(`- ${b.message}`);
  }
  if (status === 'manual_review') {
    explanationParts.push('Trade flagged for manual review due to soft limit breaches.');
  }
  if (warnings.length) {
    explanationParts.push('Warnings: ' + warnings.join('; '));
  }
  if (riskRelatedBreaches.length > 0) {
    explanationParts.push(`Monitoring context: ${riskRelatedBreaches.length} active risk-related breach(es) influenced this evaluation.`);
  }

  const result: PreTradeResult = {
    status,
    riskScore,
    breaches,
    warnings,
    recommendedQuantity,
    explanation: explanationParts.join(' '),
    metricsSnapshot,
  };

  // Audit log
  log.info('Pre-trade evaluation', {
    portfolioId, ticker, side, quantity,
    status, riskScore, breachCount: breaches.length,
  });

  return result;
}
