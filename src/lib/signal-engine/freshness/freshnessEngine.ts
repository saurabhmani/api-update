// ════════════════════════════════════════════════════════════════
//  Freshness Engine — Phase 4 (Dynamic Ranking)
//
//  Wraps signalDecay.computeFreshness() and adds two measurements
//  the base decay module doesn't produce:
//
//    1. Overextension  — how far past the entry zone the live price
//                        has travelled toward target, expressed as a
//                        fraction of the original reward distance
//                        (1R). 0 = at entry, 1.0 = target1 hit, >1 =
//                        overshot. Feeds the ranker's overextension
//                        penalty and the validator's "entry_missed"
//                        rule.
//
//    2. EntryMissed    — boolean: did price travel more than
//                        config.entryMissedAtR × |riskDistance| past
//                        the entry level in the signal's direction
//                        without the signal being filled? If yes,
//                        the trade plan is still "valid" but the
//                        opportunity is gone for new entries.
//
//  This module is pure — no IO, no DB. It is consumed by:
//    - saveSignals.ts          (at INSERT, with livePrice === entry,
//                               age = 0, so everything reads "fresh")
//    - rescoreActiveSignals.ts (per-row, every 5 min intraday)
//    - dynamicRanker.ts        (to compute freshness + overextension
//                               penalties)
//    - postSignalValidator.ts  (to decide invalidation vs downgrade)
// ════════════════════════════════════════════════════════════════

import { computeFreshness } from './signalDecay';
import type { SignalFreshness } from '../types/phase4.types';

// ── Signal direction contract ──────────────────────────────────
// Match the persisted q365_signals.direction column ('BUY' | 'SELL').
export type SignalDirection = 'BUY' | 'SELL';

export interface FreshnessInput {
  generatedAt:     string;                 // ISO or MySQL datetime
  direction:       SignalDirection;
  entryPrice:      number;
  stopLoss:        number;
  target1:         number;
  currentPrice:    number;                 // live LTP
  barsElapsed?:    number;                 // optional override
}

export interface FreshnessReport extends SignalFreshness {
  // ── Progress / overextension ────────────────────────────────
  // progressToTarget: signed, expressed as a fraction of the
  // reward distance (entry → target1). For a BUY:
  //   price = entry          → 0
  //   price = target1        → 1
  //   price = entry − 1R     → −1 (stopped out)
  //   price > target1        → >1 (overshot)
  // For a SELL the sign convention is mirrored so positive values
  // still mean "in the trade's favour".
  progressToTarget:  number;

  // overextensionPct: 0 when progressToTarget ≤ 0; otherwise equal
  // to progressToTarget clamped at a ceiling. This is what the
  // dynamicRanker penalises — a signal that has already run 80%
  // of the way to its target is not a fresh opportunity for a
  // trader looking at the dashboard right now.
  overextensionPct:  number;

  // True when price has blown past the entry zone by more than
  // entryMissedAtR × initial risk without the signal's stop or
  // target being hit. These signals should be downgraded, not
  // invalidated — the setup still reads correctly, but the
  // actionable window closed.
  entryMissed:       boolean;

  // R-multiple of adverse movement: how many units of initial
  // risk has the position drawn down from entry? Negative values
  // mean the trade is in profit. Used by the validator's stop
  // check (rule fires when this exceeds -1).
  adverseR:          number;

  // ── Raw price-drift (rotation spec) ─────────────────────────
  // Absolute price move from entry as a percentage. Used by the
  // post-signal validator's raw-move rules (downgrade at 2.5%,
  // invalidate at 4%). This is unit-coherent with how a human
  // reads a stock chart — "it's already run 3%" — whereas the
  // R-multiple measures above are about reward-distance, which
  // can land differently on low-ATR vs high-ATR names.
  movePct:           number;

  // ── Stepped age penalty (rotation spec) ─────────────────────
  // Applied ADDITIVELY on top of the existing linear freshness
  // decay. Thresholds mirror the Phase-4 rotation spec:
  //   ageBars ≤ 3  → 0
  //   ageBars  4-5 → 5
  //   ageBars  6-8 → 10
  //   ageBars > 8  → Infinity (rotation cap — validator must
  //                             invalidate via max_lifetime_reached)
  stepAgePenalty:    number;

  // Convenience flag — true when ageBars > 8 (rotation cap hit).
  // Mirrors what `stepAgePenalty === Infinity` encodes, but easier
  // for callers (validator, UI) to branch on.
  rotationCapHit:    boolean;
}

// ── Configurable thresholds ───────────────────────────────────
export interface FreshnessEngineConfig {
  // Signal is considered "entry missed" when the price has moved
  // past entry in the signal's direction by this many R.
  entryMissedAtR:    number;
  // Cap overextensionPct at this value (prevents a 5x runner from
  // producing an absurd penalty that dominates the score).
  overextensionCap:  number;

  // Stepped age-penalty thresholds (from the Phase-4 rotation spec).
  // Each entry says: "at or above this many ageBars, apply this
  // penalty in points". Evaluated largest-first; the first hit wins.
  // `Infinity` denotes the rotation cap — the validator turns this
  // into a max_lifetime_reached invalidation.
  agePenaltySteps:   Array<{ ageBars: number; penalty: number }>;
}

const DEFAULT_CONFIG: FreshnessEngineConfig = {
  entryMissedAtR:    0.6,
  overextensionCap:  2.0,
  agePenaltySteps:   [
    { ageBars: 9, penalty: Infinity },  // rotation cap — auto-invalidate
    { ageBars: 6, penalty: 10 },
    { ageBars: 4, penalty: 5 },
    { ageBars: 0, penalty: 0 },
  ],
};

export function computeFreshnessReport(
  input: FreshnessInput,
  cfg: Partial<FreshnessEngineConfig> = {},
): FreshnessReport {
  const config = { ...DEFAULT_CONFIG, ...cfg };

  const base = computeFreshness(
    input.generatedAt,
    input.currentPrice,
    input.entryPrice,
    input.barsElapsed,
  );

  const riskDistance   = Math.abs(input.entryPrice - input.stopLoss);
  const rewardDistance = Math.abs(input.target1   - input.entryPrice);

  // Raw price-drift — measured regardless of whether the plan is
  // degenerate. Used by the raw-move validator rules.
  const movePct = input.entryPrice > 0
    ? Math.abs(input.currentPrice - input.entryPrice) / input.entryPrice * 100
    : 0;

  const stepAgePenalty = resolveStepAgePenalty(base.ageBars, config.agePenaltySteps);
  const rotationCapHit = !isFinite(stepAgePenalty);

  // Guard against degenerate plans (entry == stop). A signal with
  // zero risk distance is unrankable — return neutral progress but
  // still expose movePct and stepAgePenalty so the validator can
  // rotate it off on raw-move or age grounds alone.
  if (riskDistance === 0 || rewardDistance === 0) {
    return {
      ...base,
      progressToTarget: 0,
      overextensionPct: 0,
      entryMissed:      false,
      adverseR:         0,
      movePct:          round4(movePct),
      stepAgePenalty,
      rotationCapHit,
    };
  }

  // Signed displacement in the trade's favour.
  const favourableMove = input.direction === 'BUY'
    ? input.currentPrice - input.entryPrice
    : input.entryPrice   - input.currentPrice;

  const progressToTarget = favourableMove / rewardDistance;
  const overextensionPct = progressToTarget > 0
    ? Math.min(progressToTarget, config.overextensionCap)
    : 0;

  // adverseR: positive number = drawdown in R units from entry.
  // favourableMove < 0 means price moved against the trade.
  const adverseR = favourableMove < 0
    ? Math.abs(favourableMove) / riskDistance
    : 0;

  // Entry-missed check: how far past entry has price travelled,
  // measured in R units (not reward units — we want to know how
  // much risk distance has been "used up" to get here).
  const rMultipleFromEntry = favourableMove / riskDistance;
  const entryMissed = rMultipleFromEntry > config.entryMissedAtR
    && progressToTarget < 1;  // target not hit yet

  return {
    ...base,
    progressToTarget: round4(progressToTarget),
    overextensionPct: round4(overextensionPct),
    entryMissed,
    adverseR:         round4(adverseR),
    movePct:          round4(movePct),
    stepAgePenalty,
    rotationCapHit,
  };
}

function resolveStepAgePenalty(
  ageBars: number,
  steps:   Array<{ ageBars: number; penalty: number }>,
): number {
  // Largest threshold first wins — the steps array is declared in
  // descending order, but we sort defensively so tuning the config
  // can't silently break the penalty curve.
  const sorted = [...steps].sort((a, b) => b.ageBars - a.ageBars);
  for (const step of sorted) {
    if (ageBars >= step.ageBars) return step.penalty;
  }
  return 0;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
