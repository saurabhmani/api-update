// ════════════════════════════════════════════════════════════════
//  Phase-9 Position Sizing Engine
//
//  Computes the recommended share quantity for a candidate trade
//  using a fixed-fractional risk model and four binding caps.
//
//  Formula:
//
//    base_quantity = floor( (capital × riskPerTradePct / 100)
//                            / |entryPrice − stopLoss| )
//
//  Caps (applied as min over all enabled caps):
//
//    liquidity                  → quantity ≤ maxLiquidityCapital / entry
//    single-stock exposure      → quantity ≤ ((capital × maxSingleStockPct/100)
//                                              − currentSymbolExposure) / entry
//    sector exposure            → quantity ≤ ((capital × maxSectorPct/100)
//                                              − currentSectorExposure) / entry
//    total portfolio risk       → quantity ≤ ((capital × maxTotalPortfolioRiskPct/100)
//                                              − currentTotalPortfolioRisk)
//                                            / |entry − stop|
//
//  Hard short-circuits:
//
//    riskGatePassed === false   → quantity = 0, sizing_method = 'gate_blocked'
//    entry == stop              → quantity = 0, sizing_method = 'invalid_plan'
//    any cap remaining ≤ 0      → quantity = 0, the binding cap is the method
//
//  Scope boundary:
//
//    position-sizing/positionSizer.ts  → legacy Phase-3 sizer wired
//                                         into generatePhase3Signals.
//                                         Returns the older
//                                         PositionSizingResult shape.
//
//    portfolio/positionSizingEngine.ts → THIS FILE: Phase-9 sizer
//                                         that emits the canonical
//                                         snake_case row block
//                                         persisted to the main
//                                         signal table. No callers
//                                         yet — wired by the Phase-9
//                                         integration step.
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import { round } from '../utils/math';

// ── Inputs ──────────────────────────────────────────────────────

export interface PositionSizingInput {
  symbol:                    string;
  sector:                    string;
  direction:                 'BUY' | 'SELL';
  entryPrice:                number;
  stopLoss:                  number;

  portfolioCapital:          number;
  /** Per-trade risk budget in percent of capital (e.g. 1.0 = 1 %). */
  riskPerTradePct:           number;

  // ── Caps (omit any cap to disable it) ──────────────────────────
  /** Hard $ ceiling on capital deployable into this name from
   *  liquidity (e.g. 0.5 % of 20-day ADV). */
  maxLiquidityCapital?:      number;
  /** Max single-stock gross exposure as % of capital. */
  maxSingleStockPct?:        number;
  /** Max sector gross exposure as % of capital. */
  maxSectorPct?:             number;
  /** Max total open-trade risk across the book, as % of capital. */
  maxTotalPortfolioRiskPct?: number;

  // ── Current portfolio state ────────────────────────────────────
  /** Existing gross $ already in this symbol (defaults to 0). */
  currentSymbolExposure?:    number;
  /** Existing gross $ already in this sector (defaults to 0). */
  currentSectorExposure?:    number;
  /** Existing $ at risk across all open positions (defaults to 0). */
  currentTotalPortfolioRisk?: number;

  // ── Risk gate (Phase 5/6/7 etc.) ───────────────────────────────
  /** If false the engine returns zero quantity without computing. */
  riskGatePassed:            boolean;
  /** Optional reasons echoed into sizing_warnings when gate fails. */
  riskGateReasons?:          string[];
}

// ── Outputs ─────────────────────────────────────────────────────

export type SizingMethod =
  | 'risk_based'
  | 'liquidity_capped'
  | 'single_stock_capped'
  | 'sector_capped'
  | 'total_risk_capped'
  | 'gate_blocked'
  | 'invalid_plan';

export interface ExposureAfterTrade {
  symbol_exposure:          number;
  symbol_exposure_pct:      number;
  sector_exposure:          number;
  sector_exposure_pct:      number;
  total_portfolio_risk:     number;
  total_portfolio_risk_pct: number;
}

export interface PositionSizingResult {
  symbol:               string;
  direction:            'BUY' | 'SELL';
  recommended_quantity: number;
  recommended_capital:  number;
  risk_amount:          number;
  exposure_after_trade: ExposureAfterTrade;
  sizing_method:        SizingMethod;
  sizing_warnings:      string[];
}

// ── Helpers ─────────────────────────────────────────────────────

interface CapCandidate {
  qty:    number;
  method: SizingMethod;
  /** Human-readable note appended to sizing_warnings when this cap binds. */
  note:   string;
}

function pctOf(amount: number, capital: number): number {
  if (!Number.isFinite(capital) || capital <= 0) return 0;
  return (amount / capital) * 100;
}

function emptyResult(
  input:    PositionSizingInput,
  method:   SizingMethod,
  warnings: string[],
): PositionSizingResult {
  return {
    symbol:               input.symbol,
    direction:            input.direction,
    recommended_quantity: 0,
    recommended_capital:  0,
    risk_amount:          0,
    exposure_after_trade: {
      symbol_exposure:          round(input.currentSymbolExposure     ?? 0),
      symbol_exposure_pct:      round(pctOf(input.currentSymbolExposure     ?? 0, input.portfolioCapital), 4),
      sector_exposure:          round(input.currentSectorExposure     ?? 0),
      sector_exposure_pct:      round(pctOf(input.currentSectorExposure     ?? 0, input.portfolioCapital), 4),
      total_portfolio_risk:     round(input.currentTotalPortfolioRisk ?? 0),
      total_portfolio_risk_pct: round(pctOf(input.currentTotalPortfolioRisk ?? 0, input.portfolioCapital), 4),
    },
    sizing_method:        method,
    sizing_warnings:      warnings,
  };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Run the Phase-9 sizing calculation. Returns the recommended share
 * quantity, capital deployed, $ at risk on the trade, and the
 * post-trade exposure block. Every binding cap that reduced the
 * size below the risk-based base is recorded in sizing_warnings.
 *
 * Callers writing to the main signal table should treat
 * recommended_quantity === 0 as "not sized — do not place" and
 * inspect sizing_method to attribute the cause.
 */
export function calculatePositionSize(input: PositionSizingInput): PositionSizingResult {
  const warnings: string[] = [];

  // ── Risk gate short-circuit ────────────────────────────────────
  if (!input.riskGatePassed) {
    const reasons = input.riskGateReasons && input.riskGateReasons.length > 0
      ? input.riskGateReasons.join('; ')
      : 'upstream risk gate failed';
    warnings.push(`Position blocked by risk gate: ${reasons}`);
    return emptyResult(input, 'gate_blocked', warnings);
  }

  // ── Plan sanity ────────────────────────────────────────────────
  const riskPerUnit = Math.abs(input.entryPrice - input.stopLoss);
  if (!(input.entryPrice > 0) || !(input.portfolioCapital > 0) || riskPerUnit <= 0) {
    warnings.push(
      `Invalid plan: entry=${input.entryPrice}, stop=${input.stopLoss}, ` +
      `capital=${input.portfolioCapital}`,
    );
    return emptyResult(input, 'invalid_plan', warnings);
  }

  // ── Base quantity from the fixed-fractional formula ────────────
  const riskBudget   = input.portfolioCapital * (input.riskPerTradePct / 100);
  const baseQuantity = Math.floor(riskBudget / riskPerUnit);

  if (baseQuantity <= 0) {
    warnings.push(
      `Risk budget ${round(riskBudget)} insufficient for one share ` +
      `at ${round(riskPerUnit, 4)} risk per unit`,
    );
    return emptyResult(input, 'risk_based', warnings);
  }

  // ── Cap candidates ─────────────────────────────────────────────
  const candidates: CapCandidate[] = [
    { qty: baseQuantity, method: 'risk_based',
      note: `Base sizing: ${baseQuantity} shares from ${input.riskPerTradePct}% risk budget` },
  ];

  if (typeof input.maxLiquidityCapital === 'number') {
    const qty = Math.floor(input.maxLiquidityCapital / input.entryPrice);
    candidates.push({
      qty, method: 'liquidity_capped',
      note: `Liquidity cap ${round(input.maxLiquidityCapital)} → max ${qty} shares`,
    });
  }

  if (typeof input.maxSingleStockPct === 'number') {
    const ceiling   = input.portfolioCapital * (input.maxSingleStockPct / 100);
    const remaining = ceiling - (input.currentSymbolExposure ?? 0);
    const qty       = Math.max(0, Math.floor(remaining / input.entryPrice));
    candidates.push({
      qty, method: 'single_stock_capped',
      note: `Single-stock cap ${input.maxSingleStockPct}% (${round(ceiling)}) → max ${qty} shares`,
    });
  }

  if (typeof input.maxSectorPct === 'number') {
    const ceiling   = input.portfolioCapital * (input.maxSectorPct / 100);
    const remaining = ceiling - (input.currentSectorExposure ?? 0);
    const qty       = Math.max(0, Math.floor(remaining / input.entryPrice));
    candidates.push({
      qty, method: 'sector_capped',
      note: `Sector "${input.sector}" cap ${input.maxSectorPct}% (${round(ceiling)}) → max ${qty} shares`,
    });
  }

  if (typeof input.maxTotalPortfolioRiskPct === 'number') {
    const ceiling   = input.portfolioCapital * (input.maxTotalPortfolioRiskPct / 100);
    const remaining = ceiling - (input.currentTotalPortfolioRisk ?? 0);
    const qty       = Math.max(0, Math.floor(remaining / riskPerUnit));
    candidates.push({
      qty, method: 'total_risk_capped',
      note: `Total portfolio-risk cap ${input.maxTotalPortfolioRiskPct}% ` +
            `(remaining ${round(remaining)} risk $) → max ${qty} shares`,
    });
  }

  // ── Pick the binding cap ───────────────────────────────────────
  const binding = candidates.reduce((acc, c) => (c.qty < acc.qty ? c : acc), candidates[0]);
  const finalQuantity = Math.max(0, binding.qty);

  // Note every cap that reduced size below the base. The base note
  // itself is informational only — it gets a warning when something
  // tighter clipped it, otherwise it's the success path.
  if (binding.method === 'risk_based') {
    // Base wins outright — no clipping warnings.
  } else {
    warnings.push(`Sized down from ${baseQuantity} to ${finalQuantity} shares`);
    for (const c of candidates) {
      if (c.method !== 'risk_based' && c.qty < baseQuantity) warnings.push(c.note);
    }
  }

  if (finalQuantity <= 0) {
    warnings.push('No capacity remaining under binding cap — quantity floored to 0');
    return emptyResult(input, binding.method, warnings);
  }

  // ── Post-trade exposure block ─────────────────────────────────
  const recommendedCapital = finalQuantity * input.entryPrice;
  const riskAmount         = finalQuantity * riskPerUnit;

  const symbolAfter      = (input.currentSymbolExposure     ?? 0) + recommendedCapital;
  const sectorAfter      = (input.currentSectorExposure     ?? 0) + recommendedCapital;
  const portfolioRiskAfter = (input.currentTotalPortfolioRisk ?? 0) + riskAmount;

  return {
    symbol:               input.symbol,
    direction:            input.direction,
    recommended_quantity: finalQuantity,
    recommended_capital:  round(recommendedCapital),
    risk_amount:          round(riskAmount),
    exposure_after_trade: {
      symbol_exposure:          round(symbolAfter),
      symbol_exposure_pct:      round(pctOf(symbolAfter,        input.portfolioCapital), 4),
      sector_exposure:          round(sectorAfter),
      sector_exposure_pct:      round(pctOf(sectorAfter,        input.portfolioCapital), 4),
      total_portfolio_risk:     round(portfolioRiskAfter),
      total_portfolio_risk_pct: round(pctOf(portfolioRiskAfter, input.portfolioCapital), 4),
    },
    sizing_method:        binding.method,
    sizing_warnings:      warnings,
  };
}
