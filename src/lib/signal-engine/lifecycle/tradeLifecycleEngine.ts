// ════════════════════════════════════════════════════════════════
//  Trade Lifecycle Engine — Phase NEXT
//
//  Institutional state machine for trades that have entered the
//  decision pipeline. Distinct from lifecycle/signalLifecycle.ts:
//
//    signalLifecycle.ts        legacy Phase-3 generator-side
//                              states (generated/approved/ready/
//                              entered/...). Still used for the
//                              candidate pre-execution flow.
//    tradeLifecycleEngine.ts   THIS FILE — full institutional
//                              lifecycle from candidate detection
//                              through outcome resolution.
//
//  States:
//    CANDIDATE     setup detected, no validation yet
//    DEVELOPING    seasoning across cycles, not yet promotable
//    APPROVED      passed maturity + portfolio + stress + live gates
//    EXECUTING     order working at the broker
//    ACTIVE        filled, position open
//    TARGET_HIT    target reached → outcome resolution
//    STOPPED       stop-loss triggered → outcome resolution
//    INVALIDATED   structure broken, exited before stop/target
//    EXPIRED       entry window passed without fill
//
//  Auto-expiry rules:
//    • CANDIDATE/DEVELOPING stale beyond stalenessHours → EXPIRED
//    • APPROVED unfilled past entryWindowHours        → EXPIRED
//    • EXECUTING with no fill past executionWindowMins → INVALIDATED
//    • Any state whose underlying structure is broken → INVALIDATED
//
//  Pure, synchronous, IO-free. Callers persist transitions.
// ════════════════════════════════════════════════════════════════

// ── State catalog ──────────────────────────────────────────────

export type TradeLifecycleState =
  | 'CANDIDATE'
  | 'DEVELOPING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'ACTIVE'
  | 'TARGET_HIT'
  | 'STOPPED'
  | 'INVALIDATED'
  | 'EXPIRED';

const VALID_TRANSITIONS: Record<TradeLifecycleState, TradeLifecycleState[]> = {
  CANDIDATE:   ['DEVELOPING', 'INVALIDATED', 'EXPIRED'],
  DEVELOPING:  ['APPROVED', 'INVALIDATED', 'EXPIRED'],
  APPROVED:    ['EXECUTING', 'INVALIDATED', 'EXPIRED'],
  EXECUTING:   ['ACTIVE', 'INVALIDATED', 'EXPIRED'],
  ACTIVE:      ['TARGET_HIT', 'STOPPED', 'INVALIDATED'],
  // Terminal — no further transitions:
  TARGET_HIT:  [],
  STOPPED:     [],
  INVALIDATED: [],
  EXPIRED:     [],
};

const TERMINAL_STATES: ReadonlySet<TradeLifecycleState> = new Set([
  'TARGET_HIT', 'STOPPED', 'INVALIDATED', 'EXPIRED',
]);

export function isTerminal(state: TradeLifecycleState): boolean {
  return TERMINAL_STATES.has(state);
}

// ── Lifecycle record ───────────────────────────────────────────

export interface TradeLifecycle {
  state:        TradeLifecycleState;
  reason:       string;
  /** ISO timestamp of the most recent transition. */
  changedAt:    string;
  /** Number of cycles spent in the current state. */
  cyclesInState: number;
}

export interface TransitionResult {
  ok:        boolean;
  /** New lifecycle on success; the original lifecycle on rejection. */
  lifecycle: TradeLifecycle;
  /** Human-readable rejection reason; empty on success. */
  error:     string;
}

/** Open a fresh lifecycle. Defaults to CANDIDATE. */
export function createTradeLifecycle(
  state: TradeLifecycleState = 'CANDIDATE',
  reason: string             = 'Initial candidate detection',
): TradeLifecycle {
  return {
    state,
    reason,
    changedAt:    new Date().toISOString(),
    cyclesInState: 0,
  };
}

/** Apply a transition. Rejects illegal moves. */
export function transitionTradeLifecycle(
  current:  TradeLifecycle,
  next:     TradeLifecycleState,
  reason:   string,
  now:      Date = new Date(),
): TransitionResult {
  const allowed = VALID_TRANSITIONS[current.state];
  if (!allowed || !allowed.includes(next)) {
    return {
      ok:        false,
      lifecycle: current,
      error:     `Invalid transition ${current.state} → ${next}`,
    };
  }
  return {
    ok: true,
    lifecycle: {
      state:        next,
      reason,
      changedAt:    now.toISOString(),
      cyclesInState: 0,
    },
    error: '',
  };
}

// ── Auto-expiry / invalidation ─────────────────────────────────

export interface ExpiryConfig {
  /** Max hours a CANDIDATE can sit without progressing. */
  candidateStaleHours:    number;
  /** Max hours DEVELOPING can sit without graduating. */
  developingStaleHours:   number;
  /** Max hours APPROVED can wait for execution. */
  approvedFillHours:      number;
  /** Max minutes EXECUTING can wait for a fill. */
  executingFillMinutes:   number;
  /** Max hours ACTIVE can stay open without resolution. */
  activeMaxHoldHours:     number;
}

export const DEFAULT_EXPIRY_CONFIG: ExpiryConfig = {
  candidateStaleHours:  6,
  developingStaleHours: 24,
  approvedFillHours:    8,
  executingFillMinutes: 15,
  activeMaxHoldHours:   24 * 5, // 5 trading days
};

export interface AutoExpiryInput {
  lifecycle:        TradeLifecycle;
  /** True when upstream structure-validator says the setup broke
   *  (entry zone violated by adverse close, support gone, etc.). */
  structureBroken?: boolean;
  /** Override now() for deterministic tests. */
  now?:             Date;
  config?:          ExpiryConfig;
}

export interface AutoExpiryResult {
  applied:        boolean;
  /** New lifecycle when applied=true; original otherwise. */
  lifecycle:      TradeLifecycle;
  /** Reason the transition was applied (empty when applied=false). */
  reason:         string;
}

/**
 * Idempotent sweep that decides whether stale or broken trades should
 * auto-expire / invalidate. Returns a fresh lifecycle when applied,
 * the original lifecycle untouched otherwise. Already-terminal states
 * are returned as-is so the caller can call this on every row.
 */
export function applyAutoExpiry(input: AutoExpiryInput): AutoExpiryResult {
  const { lifecycle, structureBroken } = input;
  const config = input.config ?? DEFAULT_EXPIRY_CONFIG;
  const now    = input.now ?? new Date();

  if (isTerminal(lifecycle.state)) {
    return { applied: false, lifecycle, reason: '' };
  }

  const ageMs    = now.getTime() - new Date(lifecycle.changedAt).getTime();
  const ageHours = ageMs / (60 * 60 * 1000);
  const ageMins  = ageMs / (60 * 1000);

  // Structure-broken short-circuits any state into INVALIDATED.
  if (structureBroken) {
    const t = transitionTradeLifecycle(
      lifecycle,
      'INVALIDATED',
      'Underlying structure broke — auto-invalidated',
      now,
    );
    return {
      applied:   t.ok,
      lifecycle: t.lifecycle,
      reason:    t.ok ? 'Structure broken → INVALIDATED' : t.error,
    };
  }

  switch (lifecycle.state) {
    case 'CANDIDATE': {
      if (ageHours <= config.candidateStaleHours) break;
      const t = transitionTradeLifecycle(
        lifecycle, 'EXPIRED',
        `CANDIDATE stale ${ageHours.toFixed(1)}h > ${config.candidateStaleHours}h`,
        now,
      );
      return { applied: t.ok, lifecycle: t.lifecycle, reason: t.ok ? t.lifecycle.reason : t.error };
    }
    case 'DEVELOPING': {
      if (ageHours <= config.developingStaleHours) break;
      const t = transitionTradeLifecycle(
        lifecycle, 'EXPIRED',
        `DEVELOPING stale ${ageHours.toFixed(1)}h > ${config.developingStaleHours}h`,
        now,
      );
      return { applied: t.ok, lifecycle: t.lifecycle, reason: t.ok ? t.lifecycle.reason : t.error };
    }
    case 'APPROVED': {
      if (ageHours <= config.approvedFillHours) break;
      const t = transitionTradeLifecycle(
        lifecycle, 'EXPIRED',
        `APPROVED unfilled ${ageHours.toFixed(1)}h > ${config.approvedFillHours}h entry window`,
        now,
      );
      return { applied: t.ok, lifecycle: t.lifecycle, reason: t.ok ? t.lifecycle.reason : t.error };
    }
    case 'EXECUTING': {
      if (ageMins <= config.executingFillMinutes) break;
      const t = transitionTradeLifecycle(
        lifecycle, 'INVALIDATED',
        `EXECUTING with no fill ${ageMins.toFixed(0)}m > ${config.executingFillMinutes}m`,
        now,
      );
      return { applied: t.ok, lifecycle: t.lifecycle, reason: t.ok ? t.lifecycle.reason : t.error };
    }
    case 'ACTIVE': {
      if (ageHours <= config.activeMaxHoldHours) break;
      const t = transitionTradeLifecycle(
        lifecycle, 'INVALIDATED',
        `ACTIVE held ${ageHours.toFixed(1)}h > ${config.activeMaxHoldHours}h max hold`,
        now,
      );
      return { applied: t.ok, lifecycle: t.lifecycle, reason: t.ok ? t.lifecycle.reason : t.error };
    }
  }

  return { applied: false, lifecycle, reason: '' };
}

/**
 * Bump the cyclesInState counter without changing the lifecycle
 * state. Call once per scanner tick on every non-terminal lifecycle.
 */
export function tickCycle(lifecycle: TradeLifecycle): TradeLifecycle {
  if (isTerminal(lifecycle.state)) return lifecycle;
  return { ...lifecycle, cyclesInState: lifecycle.cyclesInState + 1 };
}

// ── Allowed-transition introspection ───────────────────────────

export function allowedTransitions(state: TradeLifecycleState): TradeLifecycleState[] {
  return [...VALID_TRANSITIONS[state]];
}
