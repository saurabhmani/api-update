// ════════════════════════════════════════════════════════════════
//  riskManager — stateless evaluator that accepts or rejects a
//  signal against portfolio + policy constraints.
//
//  Call site
//  ─────────
//    const verdict = evaluateRisk(signal, portfolio.snapshot(), cfg);
//    if (!verdict.ok) return;           // drop the signal
//    // else place order with verdict.sizedQuantity
// ════════════════════════════════════════════════════════════════

import type { SignalStreamEntry } from './streams';
import type { PortfolioSnapshot } from './portfolioTracker';

export interface RiskConfig {
  maxOpenPositions:       number;
  maxGrossExposure:       number; // ₹
  maxPerSymbolExposure:   number; // ₹
  maxDailyLoss:           number; // ₹ (negative threshold as positive number)
  riskPerTradePct:        number; // fraction of equity risked per trade, e.g. 0.01 = 1%
  minConfidence:          number; // 0..1
  allowShort:             boolean;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxOpenPositions:     10,
  maxGrossExposure:     1_000_000,
  maxPerSymbolExposure: 150_000,
  maxDailyLoss:         25_000,
  riskPerTradePct:      0.01,
  minConfidence:        0.55,
  allowShort:           true,
};

export type RiskCode =
  | 'LOW_CONFIDENCE'
  | 'SHORT_DISABLED'
  | 'MAX_POSITIONS'
  | 'MAX_GROSS_EXPOSURE'
  | 'MAX_SYMBOL_EXPOSURE'
  | 'DAILY_LOSS_EXCEEDED'
  | 'INVALID_STOP'
  | 'ZERO_QUANTITY';

export interface RiskVerdict {
  ok:             boolean;
  code?:          RiskCode;
  reason?:        string;
  sizedQuantity?: number;
  riskAmount?:    number;
}

/**
 * Position-size by risk: quantity such that (entry - stop) × qty
 * ≈ equity × riskPerTradePct. Also clamped by per-symbol exposure
 * and available cash.
 */
function sizePosition(
  signal: SignalStreamEntry,
  equity: number,
  availableCash: number,
  existingSymbolExposure: number,
  cfg: RiskConfig,
): { qty: number; riskAmount: number } {
  const perShareRisk = Math.abs(signal.entry - signal.stop);
  if (perShareRisk <= 0) return { qty: 0, riskAmount: 0 };

  const riskBudget = equity * cfg.riskPerTradePct;
  const qtyByRisk = Math.floor(riskBudget / perShareRisk);

  const symbolRoom = Math.max(0, cfg.maxPerSymbolExposure - existingSymbolExposure);
  const qtyBySymbol = Math.floor(symbolRoom / signal.entry);

  const qtyByCash = Math.floor(availableCash / signal.entry);

  const qty = Math.max(0, Math.min(qtyByRisk, qtyBySymbol, qtyByCash));
  return { qty, riskAmount: qty * perShareRisk };
}

export function evaluateRisk(
  signal: SignalStreamEntry,
  portfolio: PortfolioSnapshot,
  cfg: RiskConfig = DEFAULT_RISK_CONFIG,
): RiskVerdict {
  if (signal.confidence < cfg.minConfidence) {
    return { ok: false, code: 'LOW_CONFIDENCE', reason: `confidence ${signal.confidence.toFixed(2)} < ${cfg.minConfidence}` };
  }
  if (signal.direction === 'SELL' && !cfg.allowShort && !portfolio.positions[signal.symbol]) {
    return { ok: false, code: 'SHORT_DISABLED', reason: 'short selling disabled' };
  }
  if (Math.abs(signal.entry - signal.stop) === 0) {
    return { ok: false, code: 'INVALID_STOP', reason: 'entry and stop are equal' };
  }
  if (portfolio.openPositionCount >= cfg.maxOpenPositions && !portfolio.positions[signal.symbol]) {
    return { ok: false, code: 'MAX_POSITIONS', reason: `open=${portfolio.openPositionCount}` };
  }
  if (portfolio.grossExposure >= cfg.maxGrossExposure) {
    return { ok: false, code: 'MAX_GROSS_EXPOSURE', reason: `gross=${portfolio.grossExposure}` };
  }
  if (portfolio.realizedPnlToday <= -cfg.maxDailyLoss) {
    return { ok: false, code: 'DAILY_LOSS_EXCEEDED', reason: `today=${portfolio.realizedPnlToday}` };
  }

  const existing = portfolio.positions[signal.symbol];
  const existingExposure = existing ? Math.abs(existing.quantity * existing.avgPrice) : 0;
  const { qty, riskAmount } = sizePosition(
    signal,
    portfolio.equity,
    portfolio.cash,
    existingExposure,
    cfg,
  );

  if (qty <= 0) {
    return { ok: false, code: 'ZERO_QUANTITY', reason: 'sizer returned 0' };
  }

  return { ok: true, sizedQuantity: qty, riskAmount };
}
