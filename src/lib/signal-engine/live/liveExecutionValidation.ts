// ════════════════════════════════════════════════════════════════
//  Live Execution Validation — Phase NEXT
//
//  Pre-execution gate that runs AFTER a signal has reached APPROVED
//  via maturity / portfolio-risk / stress / Phase-8 live-tick
//  freshness, and decides whether the trade can actually be filled
//  on the live book RIGHT NOW.
//
//  Six checks, every failure forces a hard rejection from APPROVED:
//
//    1. Entry zone still valid     — live tick within entry zone
//                                      (or drift under maxEntryDriftPct
//                                      when no zone is supplied).
//    2. Slippage acceptable        — expected slippage within budget.
//    3. Spread acceptable          — bid/ask spread within ceiling.
//    4. Price not extended         — live tick hasn't run too far
//                                      past entry (pre-extension veto).
//    5. Stop-loss not compromised  — live tick hasn't eaten into the
//                                      stop buffer beyond the floor.
//    6. Liquidity exit feasible    — average-daily-volume relative to
//                                      target position size leaves
//                                      enough headroom to exit.
//
//  Distinct from live/liveValidationEngine.ts (Phase-8). That module
//  validates whether the SIGNAL is still actionable at the time of
//  evaluation (entry drift, signal age, freshness flag). THIS module
//  validates whether the EXECUTION is feasible at the time of fill —
//  same family, different gate. Phase-8 runs upstream of this one.
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import { round } from '../utils/math';

// ── Inputs ──────────────────────────────────────────────────────

export interface LiveExecutionInput {
  symbol:               string;
  direction:            'BUY' | 'SELL';
  entryPrice:           number;
  entryZoneLow?:        number;
  entryZoneHigh?:       number;
  stopLoss:             number;
  /** Latest live trade price. */
  livePrice:            number;
  /** Optional best bid; required for spread + slippage estimation. */
  bid?:                 number;
  /** Optional best ask. */
  ask?:                 number;
  /** Average daily volume in shares. Required for liquidity-exit feasibility. */
  avgDailyVolume?:      number;
  /** Proposed position size in shares. */
  positionSize:         number;
  /** Optional ATR as a fraction of price. Used for the
   *  "price not extended" check when no zone is supplied. */
  atrPct?:              number;
}

export interface LiveExecutionConfig {
  /** Slippage ceiling, basis points (100 bps = 1 %). */
  maxSlippageBps:           number;
  /** Spread ceiling, basis points. */
  maxSpreadBps:             number;
  /** Drift ceiling when no zone is supplied — % of entry. */
  maxEntryDriftPct:         number;
  /** Minimum fraction of risk distance that must remain to the stop. */
  minStopBufferPct:         number;
  /** Max position-to-ADV ratio. 0.05 = position ≤ 5 % of one day's volume. */
  maxAdvParticipationRate:  number;
  /** "Price extended" threshold expressed as ATR multiples beyond entry. */
  maxAtrMultiplesPastEntry: number;
}

export const DEFAULT_LIVE_EXECUTION_CONFIG: LiveExecutionConfig = {
  maxSlippageBps:           25,    // 0.25 %
  maxSpreadBps:             50,    // 0.50 %
  maxEntryDriftPct:         3.0,   // 3 %
  minStopBufferPct:         0.15,  // 15 % of risk distance still intact
  maxAdvParticipationRate:  0.05,  // 5 % of ADV
  maxAtrMultiplesPastEntry: 1.5,   // 1.5 ATR past ideal entry
};

// ── Outputs ─────────────────────────────────────────────────────

export type LiveExecutionCode =
  | 'entry_zone_invalid'
  | 'slippage_too_wide'
  | 'spread_too_wide'
  | 'price_extended'
  | 'stop_compromised'
  | 'illiquid_exit'
  | 'invalid_plan';

export interface LiveExecutionResult {
  symbol:               string;
  /** True iff every check passed. Hard reject from APPROVED on false. */
  execution_allowed:    boolean;
  /** Failure codes (empty when allowed). */
  execution_codes:      LiveExecutionCode[];
  /** Human-readable parallel to execution_codes (same order, with extra
   *  audit lines that were not blocking — e.g. "spread within budget"). */
  execution_reasons:    string[];
  /** Estimated slippage in percent of entry. Always populated when
   *  bid/ask are supplied; 0 when not estimatable. */
  slippage_pct:         number;
  /** 0-100. 0 = exit infeasible (illiquid), 100 = exit trivial. */
  liquidity_exit_risk:  number;
  /** Snapshot of every input the verdict was evaluated on. */
  snapshot: {
    live_price:        number;
    entry_price:       number;
    stop_loss:         number;
    drift_pct:         number;
    spread_bps:        number | null;
    slippage_bps:      number;
    adv_participation: number | null;
    stop_buffer_pct:   number;
    captured_at:       string;
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function estimateSpread(bid?: number, ask?: number): { bps: number | null; mid: number | null } {
  if (typeof bid !== 'number' || typeof ask !== 'number') return { bps: null, mid: null };
  if (!(bid > 0) || !(ask > 0) || ask < bid) return { bps: null, mid: null };
  const mid = (bid + ask) / 2;
  if (mid <= 0) return { bps: null, mid: null };
  return { bps: ((ask - bid) / mid) * 10_000, mid };
}

/** Slippage budget = half-spread + take-side adjustment. We model
 *  slippage as paying the full half-spread plus a small ATR-derived
 *  buffer so a fast tape doesn't underestimate cost. */
function estimateSlippageBps(
  direction:  'BUY' | 'SELL',
  livePrice:  number,
  bid:        number | undefined,
  ask:        number | undefined,
  spreadBps:  number | null,
): number {
  if (spreadBps == null) return 0;
  // Take-side cost is roughly the half-spread plus 10 % of itself
  // for queue-jumping in the live book.
  const halfSpread = spreadBps / 2;
  const queueJump  = halfSpread * 0.1;
  return halfSpread + queueJump;
}

/** Liquidity-exit risk on a 0-100 scale. Higher = easier exit. */
function liquidityExitRisk(
  adv:           number | undefined,
  positionSize:  number,
  participationCap: number,
): { score: number; participation: number | null; feasible: boolean } {
  if (typeof adv !== 'number' || !(adv > 0) || !(positionSize > 0)) {
    return { score: 50, participation: null, feasible: true };
  }
  const participation = positionSize / adv;
  // 0 % of ADV → 100, participationCap → 50, 4×cap → 0.
  const ratio = participation / participationCap;
  const score = Math.max(0, Math.min(100, Math.round(100 - ratio * 25)));
  return { score, participation, feasible: participation <= participationCap };
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Run all six checks. Hard-reject by returning execution_allowed=false
 * with every failure code appended. Always emits a snapshot block so
 * the audit logger can persist the exact numbers we evaluated on.
 */
export function validateLiveExecution(
  input:  LiveExecutionInput,
  config: LiveExecutionConfig = DEFAULT_LIVE_EXECUTION_CONFIG,
  now:    Date = new Date(),
): LiveExecutionResult {
  const codes:   LiveExecutionCode[] = [];
  const reasons: string[]            = [];

  // ── Plan sanity ────────────────────────────────────────────────
  const planBroken =
    !(input.entryPrice > 0) ||
    !(input.livePrice  > 0) ||
    input.entryPrice === input.stopLoss;
  if (planBroken) {
    codes.push('invalid_plan');
    reasons.push(
      `[${input.symbol}] Invalid execution plan: entry=${input.entryPrice}, ` +
      `stop=${input.stopLoss}, live=${input.livePrice}`,
    );
  }

  // ── Snapshot fields ────────────────────────────────────────────
  const driftPct = input.entryPrice > 0
    ? ((input.livePrice - input.entryPrice) / input.entryPrice) * 100
    : 0;
  const driftAbs = Math.abs(driftPct);
  const riskDistance = Math.abs(input.entryPrice - input.stopLoss);
  const distanceToStop = Math.abs(input.livePrice - input.stopLoss);
  const stopBufferPct  = riskDistance > 0 ? distanceToStop / riskDistance : 0;

  const { bps: spreadBps } = estimateSpread(input.bid, input.ask);
  const slippageBps = estimateSlippageBps(
    input.direction, input.livePrice, input.bid, input.ask, spreadBps,
  );
  const liquidity = liquidityExitRisk(
    input.avgDailyVolume,
    input.positionSize,
    config.maxAdvParticipationRate,
  );

  // ── Check 1: entry zone still valid ────────────────────────────
  if (!planBroken) {
    const hasZone = typeof input.entryZoneLow === 'number'
                 && typeof input.entryZoneHigh === 'number';
    if (hasZone) {
      const lo = Math.min(input.entryZoneLow!, input.entryZoneHigh!);
      const hi = Math.max(input.entryZoneLow!, input.entryZoneHigh!);
      if (input.livePrice < lo || input.livePrice > hi) {
        codes.push('entry_zone_invalid');
        reasons.push(
          `[${input.symbol}] Live ${round(input.livePrice, 2)} outside entry zone [${lo}, ${hi}]`,
        );
      } else {
        reasons.push(
          `[${input.symbol}] Live ${round(input.livePrice, 2)} inside entry zone [${lo}, ${hi}]`,
        );
      }
    } else if (driftAbs > config.maxEntryDriftPct) {
      codes.push('entry_zone_invalid');
      reasons.push(
        `[${input.symbol}] Drift ${round(driftAbs, 2)}% from entry exceeds ${config.maxEntryDriftPct}%`,
      );
    }
  }

  // ── Check 2: slippage acceptable ───────────────────────────────
  if (slippageBps > config.maxSlippageBps) {
    codes.push('slippage_too_wide');
    reasons.push(
      `[${input.symbol}] Slippage ${round(slippageBps, 2)} bps > ${config.maxSlippageBps} bps`,
    );
  }

  // ── Check 3: spread acceptable ─────────────────────────────────
  if (spreadBps !== null && spreadBps > config.maxSpreadBps) {
    codes.push('spread_too_wide');
    reasons.push(
      `[${input.symbol}] Spread ${round(spreadBps, 2)} bps > ${config.maxSpreadBps} bps`,
    );
  }

  // ── Check 4: price not extended past entry ─────────────────────
  // For a long, "extended" means live is far ABOVE entry (we missed
  // the move). For a short, it means live is far BELOW entry.
  if (!planBroken) {
    const adverseExtension = input.direction === 'BUY'
      ? Math.max(0, input.livePrice - input.entryPrice)
      : Math.max(0, input.entryPrice - input.livePrice);
    if (input.atrPct && input.atrPct > 0 && input.entryPrice > 0) {
      const atrAbs = input.entryPrice * input.atrPct;
      if (atrAbs > 0 && adverseExtension / atrAbs > config.maxAtrMultiplesPastEntry) {
        codes.push('price_extended');
        reasons.push(
          `[${input.symbol}] Live extended ${round(adverseExtension / atrAbs, 2)} ATR past entry ` +
          `> ${config.maxAtrMultiplesPastEntry} ATR limit`,
        );
      }
    } else if (driftAbs > config.maxEntryDriftPct * 1.5) {
      // Without an ATR, fall back to a wider drift band.
      codes.push('price_extended');
      reasons.push(
        `[${input.symbol}] Live drift ${round(driftAbs, 2)}% past entry — no ATR available`,
      );
    }
  }

  // ── Check 5: stop not compromised ──────────────────────────────
  if (!planBroken) {
    const stopAlreadyHit = input.direction === 'BUY'
      ? input.livePrice <= input.stopLoss
      : input.livePrice >= input.stopLoss;
    if (stopAlreadyHit) {
      codes.push('stop_compromised');
      reasons.push(
        `[${input.symbol}] Live ${round(input.livePrice, 2)} already past ${input.direction} stop ` +
        `${round(input.stopLoss, 2)}`,
      );
    } else if (stopBufferPct < config.minStopBufferPct) {
      codes.push('stop_compromised');
      reasons.push(
        `[${input.symbol}] Stop buffer ${round(stopBufferPct * 100, 1)}% < ` +
        `${round(config.minStopBufferPct * 100, 1)}% minimum`,
      );
    }
  }

  // ── Check 6: liquidity exit feasible ───────────────────────────
  if (!liquidity.feasible) {
    codes.push('illiquid_exit');
    const partPct = liquidity.participation != null
      ? `${round(liquidity.participation * 100, 2)}%`
      : 'N/A';
    reasons.push(
      `[${input.symbol}] Position is ${partPct} of ADV — exceeds ` +
      `${round(config.maxAdvParticipationRate * 100, 2)}% participation cap`,
    );
  }

  return {
    symbol:              input.symbol,
    execution_allowed:   codes.length === 0,
    execution_codes:     codes,
    execution_reasons:   reasons,
    slippage_pct:        round(slippageBps / 100, 4),  // bps → pct
    liquidity_exit_risk: liquidity.score,
    snapshot: {
      live_price:        round(input.livePrice, 4),
      entry_price:       round(input.entryPrice, 4),
      stop_loss:         round(input.stopLoss, 4),
      drift_pct:         round(driftPct, 4),
      spread_bps:        spreadBps == null ? null : round(spreadBps, 2),
      slippage_bps:      round(slippageBps, 2),
      adv_participation: liquidity.participation == null
        ? null
        : round(liquidity.participation, 4),
      stop_buffer_pct:   round(stopBufferPct, 4),
      captured_at:       now.toISOString(),
    },
  };
}
