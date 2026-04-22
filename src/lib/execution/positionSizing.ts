// ════════════════════════════════════════════════════════════════
//  positionSizing — risk-based quantity calculator
//
//  Canonical formula:
//
//      quantity = floor( (capital × risk%) / |entry - stopLoss| )
//
//  Rationale:
//    - `capital × risk%` is the amount you're willing to lose on
//      this one trade (the "risk budget")
//    - `|entry - stopLoss|` is the per-share loss if the stop fires
//    - the ratio is how many shares put exactly risk% at risk
//
//  Guards built in:
//    - Missing or zero stop distance → fall back to DEFAULT_QTY
//      (we never return 0; the executor already has a min-qty
//      floor, but we surface why via the `reason` field so you
//      can see it in logs)
//    - Cap per trade at MAX_QTY to prevent a pathological stop
//      (0.01 away from entry) from sending a million shares
//    - Cap notional at MAX_NOTIONAL so a cheap stock doesn't
//      blow through margin even if MAX_QTY is high
//    - Everything is Math.floor — never round up, never over-spend
//      the budget
//
//  All knobs come from env so you can retune without a deploy:
//      EXECUTION_CAPITAL       total working capital, INR
//      EXECUTION_RISK_PCT      % of capital to risk per trade
//      EXECUTION_DEFAULT_QTY   fallback when stop is missing
//      EXECUTION_MAX_QTY       absolute per-trade qty ceiling
//      EXECUTION_MAX_NOTIONAL  absolute per-trade notional ceiling
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ component: 'positionSizing' });

const CAPITAL       = Number(process.env.EXECUTION_CAPITAL)      || 100_000;
const RISK_PCT      = Number(process.env.EXECUTION_RISK_PCT)     || 1;    // percent
const DEFAULT_QTY   = Number(process.env.EXECUTION_DEFAULT_QTY)  || 1;
const MAX_QTY       = Number(process.env.EXECUTION_MAX_QTY)      || 1000;
const MAX_NOTIONAL  = Number(process.env.EXECUTION_MAX_NOTIONAL) || 200_000;

// Portfolio-wide notional cap. Prevents 5 × ₹200K trades
// (each within MAX_NOTIONAL) from saturating a ₹500K account.
// Defaults to CAPITAL so you can't accidentally over-leverage
// without explicitly opting in.
const MAX_PORTFOLIO_NOTIONAL =
  Number(process.env.EXECUTION_MAX_PORTFOLIO_NOTIONAL) || CAPITAL;

export interface SizeInput {
  entry:    number;
  stopLoss?: number | null;
}

export interface SizeResult {
  quantity: number;
  capitalAtRisk: number;
  notional:     number;
  reason:       string;
}

export function calculateQuantity(input: SizeInput): SizeResult {
  const { entry } = input;
  const stop = input.stopLoss ?? null;

  if (!Number.isFinite(entry) || entry <= 0) {
    return {
      quantity:      DEFAULT_QTY,
      capitalAtRisk: 0,
      notional:      DEFAULT_QTY * Math.max(entry, 0),
      reason:        'invalid entry — fell back to DEFAULT_QTY',
    };
  }

  const riskBudget = CAPITAL * (RISK_PCT / 100);

  let qty: number;
  let reason: string;

  if (stop == null || !Number.isFinite(stop) || stop === entry) {
    // No stop distance → we can't derive a risk-based qty. Fall
    // back to the configured floor. The caller decides whether to
    // still send the trade; position sizing is not the right place
    // to make that call.
    qty = DEFAULT_QTY;
    reason = 'no stop distance — used DEFAULT_QTY';
  } else {
    const stopDistance = Math.abs(entry - stop);
    qty = Math.floor(riskBudget / stopDistance);
    reason = `risk=${RISK_PCT}% capital=${CAPITAL} stopDist=${stopDistance.toFixed(2)}`;

    if (qty < 1) {
      // Risk budget smaller than one share — either the stop is
      // too far away or the capital is too small. Falling back to
      // DEFAULT_QTY would VIOLATE the budget; better to return 0
      // and let the executor reject the trade cleanly.
      return {
        quantity: 0,
        capitalAtRisk: 0,
        notional: 0,
        reason: `risk budget (₹${riskBudget.toFixed(0)}) < stop distance (₹${stopDistance.toFixed(2)}) — trade too expensive`,
      };
    }
  }

  // ── Cap by absolute qty ───────────────────────────────────
  if (qty > MAX_QTY) {
    qty = MAX_QTY;
    reason += `; capped at MAX_QTY=${MAX_QTY}`;
  }

  // ── Cap by notional ───────────────────────────────────────
  const notionalUnclamped = qty * entry;
  if (notionalUnclamped > MAX_NOTIONAL) {
    qty = Math.floor(MAX_NOTIONAL / entry);
    reason += `; capped at MAX_NOTIONAL=₹${MAX_NOTIONAL}`;
  }

  const capitalAtRisk = stop != null ? qty * Math.abs(entry - stop) : 0;
  return {
    quantity: qty,
    capitalAtRisk,
    notional: qty * entry,
    reason,
  };
}

export function getSizingConfig() {
  return {
    capital:             CAPITAL,
    riskPct:             RISK_PCT,
    defaultQty:          DEFAULT_QTY,
    maxQty:              MAX_QTY,
    maxNotional:         MAX_NOTIONAL,
    maxPortfolioNotional: MAX_PORTFOLIO_NOTIONAL,
  };
}

// ── Aggregate portfolio exposure check ────────────────────────
//
// Async because it reads the open book from the DB. Called AFTER
// calculateQuantity (which is sync and in-memory) and BEFORE
// openPendingPosition (so we haven't written anything we'd have
// to roll back). If we're over budget, the executor rejects the
// signal with a clean reason and the position is never created.
//
// A small tolerance margin (0.5%) is added so intraday price
// drift on existing positions doesn't flip a legitimate new
// signal to rejected — the cap is a hard portfolio gate, not a
// millisecond-accurate mark-to-market.

import { getAggregateOpenNotional } from './persistence';

export interface ExposureCheck {
  allow: boolean;
  reason?: string;
  current?: number;
  proposed?: number;
  cap?: number;
}

export async function checkAggregateExposure(
  proposedNotional: number,
): Promise<ExposureCheck> {
  try {
    const current = await getAggregateOpenNotional();
    const total = current + proposedNotional;
    const cap = MAX_PORTFOLIO_NOTIONAL * 1.005; // +0.5% mark-to-market slack
    if (total > cap) {
      return {
        allow: false,
        reason:
          `portfolio notional ₹${total.toFixed(0)} would exceed cap ` +
          `₹${MAX_PORTFOLIO_NOTIONAL.toFixed(0)} (current=₹${current.toFixed(0)}, ` +
          `proposed=₹${proposedNotional.toFixed(0)})`,
        current,
        proposed: proposedNotional,
        cap: MAX_PORTFOLIO_NOTIONAL,
      };
    }
    return { allow: true, current, proposed: proposedNotional, cap: MAX_PORTFOLIO_NOTIONAL };
  } catch (err: any) {
    // Fail closed — if we can't read the book, we can't prove we're
    // within limits, so we don't send new orders. A flaky DB should
    // never quietly increase risk.
    console.error('[positionSizing] exposure check DB error:', err?.message);
    return { allow: false, reason: 'exposure check failed — fail closed' };
  }
}
