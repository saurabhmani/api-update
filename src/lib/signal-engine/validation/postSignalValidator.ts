// ════════════════════════════════════════════════════════════════
//  Post-Signal Validator — Phase 4 (Dynamic Ranking)
//
//  Runs against a LIVE signal row + live LTP and produces a
//  terminal verdict that rescoreActiveSignals persists to
//  q365_signals.invalidation_reason / q365_signals.status.
//
//  Rules (evaluated in order — first hit wins):
//
//    1. stop_violated
//         Live price has moved >= 1R against the trade from entry.
//         → verdict = 'invalidate', status = 'expired'.
//
//    2. target_hit
//         Live price has reached target1 (or better).
//         → verdict = 'invalidate', status = 'expired'.
//         (We don't keep realised trades on the dashboard — the
//         lifecycle table records them, the top-signals feed is
//         only for still-actionable setups.)
//
//    3. structure_break
//         Freshness decayState already says 'expired' AND age > 1
//         trading day. Reserved for the background cron: if a
//         signal has sat through a full session without being
//         filled or stopped, the technical setup that generated
//         it (breakout level, pullback zone) is no longer the
//         dominant state of the tape.
//         → verdict = 'invalidate', status = 'expired'.
//
//    4. entry_missed_extended
//         Price has travelled > entryMissedAtR × R past the entry
//         in the trade's direction. The setup is still valid but
//         the entry window closed — we keep the row visible as
//         'flagged' so traders can see the move happened, just
//         heavily downgraded in ranking.
//         → verdict = 'downgrade', status = 'flagged'.
//
//  No rule fire → verdict = 'keep', status unchanged.
// ════════════════════════════════════════════════════════════════

import type { FreshnessReport, SignalDirection } from '../freshness/freshnessEngine';

export type ValidationAction =
  | 'keep'        // signal stays active, only freshness score moves
  | 'downgrade'   // stays visible, status → 'flagged', final_score heavily reduced
  | 'invalidate'; // status → 'expired', removed from top list

export type InvalidationReason =
  | 'stop_violated'
  | 'target_hit'
  | 'structure_break'
  | 'entry_missed_extended'
  | 'price_drifted'            // raw move > 2.5%, trade plan still technically valid
  | 'price_overextended'       // raw move > 4%, too far gone to take
  | 'max_lifetime_reached';    // rotation cap — ageBars > 8

export interface ValidationInput {
  direction:       SignalDirection;
  entryPrice:      number;
  stopLoss:        number;
  target1:         number;
  currentPrice:    number;
  freshness:       FreshnessReport;
}

export interface ValidationVerdict {
  action:          ValidationAction;
  reason:          InvalidationReason | null;
  nextStatus:      'active' | 'flagged' | 'expired';
  // Hard multiplier applied to the base final_score. 1.0 = no
  // change, 0.2 = drop to 20% (used for downgrade). Invalidate
  // uses 0 — the row is excluded from the WHERE clause anyway
  // but we zero the score defensively.
  scoreMultiplier: number;
}

export interface ValidatorConfig {
  // Stop-hit tolerance: fire when adverseR >= this. 1.0 means
  // "price reached the stop"; 0.95 would give a small buffer
  // for ticks that nicked the stop intrabar without closing
  // through it. Default is tight because we're validating on
  // live LTP, not closing prices.
  stopHitThreshold:     number;

  // Age in hours above which a stale signal is treated as a
  // structure break. Prevents signals generated yesterday from
  // staying on the board through today's completely different
  // tape.
  structureBreakAgeHrs: number;

  // Raw price-drift thresholds (percentage). The 2.5% level
  // downgrades the signal; the 4% level hard-invalidates it.
  // These fire AGAINST ANY direction of move — if LUPIN has
  // run +5% from the entry the trade is "gone", and if it has
  // dumped -5% the setup is broken. Both are rotation triggers.
  priceDriftDowngradePct:   number;
  priceOverextendedPct:     number;
}

const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  stopHitThreshold:         1.0,
  structureBreakAgeHrs:     20,
  priceDriftDowngradePct:   2.5,
  priceOverextendedPct:     5.0,  // spec: reject when |live-entry|/entry > 5%
};

export function validatePostSignal(
  input: ValidationInput,
  cfg: Partial<ValidatorConfig> = {},
): ValidationVerdict {
  const config = { ...DEFAULT_VALIDATOR_CONFIG, ...cfg };
  const { freshness, currentPrice, target1, direction } = input;

  // ── Rule 1: stop violated ──────────────────────────────────
  if (freshness.adverseR >= config.stopHitThreshold) {
    return {
      action:          'invalidate',
      reason:          'stop_violated',
      nextStatus:      'expired',
      scoreMultiplier: 0,
    };
  }

  // ── Rule 2: target hit ─────────────────────────────────────
  const targetHit = direction === 'BUY'
    ? currentPrice >= target1
    : currentPrice <= target1;
  if (targetHit) {
    return {
      action:          'invalidate',
      reason:          'target_hit',
      nextStatus:      'expired',
      scoreMultiplier: 0,
    };
  }

  // ── Rule 3: max-lifetime rotation cap ──────────────────────
  // Hard cap on how long a signal can sit on the board. Fires at
  // ageBars > 8 regardless of whether price has moved. This is
  // what guarantees visible rotation — a setup that "technically
  // still reads" but has been sitting in limbo for 9 trading days
  // gets cycled off to make room for fresher opportunities.
  if (freshness.rotationCapHit) {
    return {
      action:          'invalidate',
      reason:          'max_lifetime_reached',
      nextStatus:      'expired',
      scoreMultiplier: 0,
    };
  }

  // ── Rule 4: price overextended (raw move > 4%) ─────────────
  // Any direction of move. A BUY signal whose stock ran +5% is
  // "too late to take"; a BUY signal whose stock dumped -5% has
  // broken its setup. Either way, rotate it off.
  if (freshness.movePct > config.priceOverextendedPct) {
    return {
      action:          'invalidate',
      reason:          'price_overextended',
      nextStatus:      'expired',
      scoreMultiplier: 0,
    };
  }

  // ── Rule 5: structure break (decay + age) ──────────────────
  if (freshness.decayState === 'expired'
      && freshness.ageHours >= config.structureBreakAgeHrs) {
    return {
      action:          'invalidate',
      reason:          'structure_break',
      nextStatus:      'expired',
      scoreMultiplier: 0,
    };
  }

  // ── Rule 6: entry missed / extended (R-based) ──────────────
  // Fires earlier than price_drifted on low-ATR names — a stock
  // that moved 0.6R may have only moved 1% in raw %, but the
  // R-based check catches it first. Both rules coexist.
  if (freshness.entryMissed) {
    return {
      action:          'downgrade',
      reason:          'entry_missed_extended',
      nextStatus:      'flagged',
      scoreMultiplier: 0.25,
    };
  }

  // ── Rule 7: raw-move drift (> 2.5%) ────────────────────────
  // Softer rotation trigger. The setup isn't dead, but the entry
  // window is narrowing. Multiplier 0.4 keeps the signal visible
  // as a downgraded/flagged row so the operator can see what was
  // missed without it occupying a top-50 slot.
  if (freshness.movePct > config.priceDriftDowngradePct) {
    return {
      action:          'downgrade',
      reason:          'price_drifted',
      nextStatus:      'flagged',
      scoreMultiplier: 0.4,
    };
  }

  // ── No rule fired ──────────────────────────────────────────
  return {
    action:          'keep',
    reason:          null,
    nextStatus:      'active',
    scoreMultiplier: 1.0,
  };
}
