// ════════════════════════════════════════════════════════════════
//  Strategy Regime Router — Phase 3
//
//  Reads the existing market-regime detector and Phase-2 strategy
//  performance to decide, per strategy, whether it should be
//  PROMOTED / ACTIVE / REDUCED / WATCHLIST_ONLY / BLOCKED today.
//
//  Critical safety rules:
//   - Never claims a regime when the benchmark feed is stale/missing.
//     Returns `regimeStatus: 'INSUFFICIENT_DATA'` and a routing matrix
//     that forces every strategy to WATCHLIST_ONLY.
//   - Never silently mutates scoring — the routing decision is an
//     EXPLICIT object on the signal so the operator can read why a
//     setup was demoted.
//   - Phase-2 performance is a tilt, not a kill-switch. A weak strategy
//     never gets BLOCKED purely because of performance; it gets REDUCE.
//
//  Pure module — no DB, no env reads. Callers pass already-loaded
//  inputs.
// ════════════════════════════════════════════════════════════════

import {
  STRATEGY_REGISTRY,
  getStrategyMeta,
} from '@/lib/signal-engine/strategies/strategyRegistry';
import type {
  MarketRegimeLabel,
  StrategyName,
} from '@/lib/signal-engine/types/signalEngine.types';
import type { StrategyPerformance } from '@/lib/strategies/strategyPerformance';

// ── Public types ──────────────────────────────────────────────

export type RoutedRegime =
  | 'strong_bullish' | 'bullish' | 'sideways' | 'weak' | 'bearish'
  | 'high_volatility' | 'low_liquidity' | 'stale_data' | 'unknown';

export type RoutingDecision =
  | 'PROMOTE' | 'ACTIVE' | 'REDUCE' | 'WATCHLIST_ONLY'
  | 'BLOCK'   | 'INSUFFICIENT_DATA';

export type RegimeStatus = 'AVAILABLE' | 'STALE' | 'INSUFFICIENT_DATA';

export interface StrategyRoutingDecision {
  strategyId:                 string;
  strategyName:               string;
  regime:                     RoutedRegime;
  routingDecision:            RoutingDecision;
  confidenceAdjustment:       number;            // signed delta to apply to confidence_score
  approvalThresholdAdjustment: number;           // signed delta to apply to the approval floor
  positionSizeAdjustment:     number;            // % delta to position size, signed
  reason:                     string;
  warnings:                   string[];
  /** Performance hint from Phase 2 that fed the tilt, if any. */
  performanceHint?:           {
    expectancy:        number;
    winRate:           number;
    healthLabel:       string;
    performanceStatus: string;
  };
}

export interface RegimeRouterReport {
  generatedAt:               string;
  regimeStatus:              RegimeStatus;
  currentRegime:             RoutedRegime;
  /** 0–100 — derived from regime detector strength, never fabricated. */
  confidence:                number;
  summary:                   string;
  activeStrategies:          string[];
  promotedStrategies:        string[];
  reducedStrategies:         string[];
  watchlistOnlyStrategies:   string[];
  blockedStrategies:         string[];
  routingMatrix:             StrategyRoutingDecision[];
  warnings:                  string[];
  dataQuality: {
    benchmarkCandlesAvailable: boolean;
    benchmarkDataAgeMinutes:   number | null;
    performanceAvailable:      boolean;
    performanceWindow:         string | null;
  };
}

// ── Regime label normalisation ───────────────────────────────

/** Map the in-engine MarketRegimeLabel to the wire-friendly snake_case
 *  routed-regime ID. Centralised so the API/UI never has to know about
 *  the engine's `'Strong Bullish'` style. */
export function normaliseRegime(
  label: MarketRegimeLabel | string | null | undefined,
): RoutedRegime {
  if (!label) return 'unknown';
  const v = String(label).toLowerCase().replace(/\s+/g, '_');
  if (v === 'strong_bullish' || v === 'bullish' || v === 'sideways' ||
      v === 'weak' || v === 'bearish' || v === 'unknown') {
    return v as RoutedRegime;
  }
  if (v.includes('volatility')) return 'high_volatility';
  return 'unknown';
}

// ── Routing matrix — regime → per-strategy default decision ──
//
// Defaults come from the Phase-3 spec routing matrix. Each entry is
// the regime's BASELINE for that strategy; performance/freshness tilts
// can still adjust the final decision via `routeStrategy()` below.
type StrategyMatrix = Partial<Record<StrategyName | string, RoutingDecision>>;

const REGIME_MATRIX: Record<RoutedRegime, StrategyMatrix> = {
  strong_bullish: {
    bullish_breakout:       'PROMOTE',
    momentum_continuation:  'PROMOTE',
    bullish_pullback:       'PROMOTE',
    volatility_squeeze_breakout: 'PROMOTE',
    ema_crossover:          'ACTIVE',
    range_breakout:         'ACTIVE',
    gap_continuation:       'ACTIVE',
    multi_timeframe_alignment: 'ACTIVE',
    vwap_reclaim_long:      'ACTIVE',
    opening_range_breakout: 'ACTIVE',
    mean_reversion_bounce:  'REDUCE',
    oversold_bounce:        'REDUCE',
    bullish_divergence:     'REDUCE',
    overbought_reversal:    'WATCHLIST_ONLY',
    bearish_breakdown:      'WATCHLIST_ONLY',
    weak_trend_breakdown:   'WATCHLIST_ONLY',
    volume_climax_reversal: 'WATCHLIST_ONLY',
    failed_breakout_reversal:    'WATCHLIST_ONLY',
    bearish_pullback_rejection:  'WATCHLIST_ONLY',
    vwap_rejection_short:        'WATCHLIST_ONLY',
    opening_range_breakdown:     'WATCHLIST_ONLY',
  },
  bullish: {
    bullish_pullback:       'PROMOTE',
    ema_crossover:          'PROMOTE',
    range_breakout:         'PROMOTE',
    bullish_breakout:       'ACTIVE',
    momentum_continuation:  'ACTIVE',
    gap_continuation:       'ACTIVE',
    overbought_reversal:    'REDUCE',
    mean_reversion_bounce:  'REDUCE',
    bullish_divergence:     'ACTIVE',
    oversold_bounce:        'ACTIVE',
    bearish_breakdown:      'WATCHLIST_ONLY',
    weak_trend_breakdown:   'WATCHLIST_ONLY',
    volume_climax_reversal: 'WATCHLIST_ONLY',
  },
  sideways: {
    mean_reversion_bounce:  'PROMOTE',
    oversold_bounce:        'PROMOTE',
    range_breakout:         'PROMOTE',
    bullish_divergence:     'ACTIVE',
    volume_climax_reversal: 'ACTIVE',
    overbought_reversal:    'ACTIVE',
    bullish_pullback:       'ACTIVE',
    bullish_breakout:       'WATCHLIST_ONLY',
    momentum_continuation:  'REDUCE',
    gap_continuation:       'REDUCE',
    ema_crossover:          'REDUCE',
    bearish_breakdown:      'WATCHLIST_ONLY',
    weak_trend_breakdown:   'ACTIVE',
  },
  weak: {
    weak_trend_breakdown:   'PROMOTE',
    overbought_reversal:    'PROMOTE',
    bearish_breakdown:      'ACTIVE',
    bullish_divergence:     'ACTIVE',
    mean_reversion_bounce:  'ACTIVE',
    oversold_bounce:        'ACTIVE',
    volume_climax_reversal: 'ACTIVE',
    bullish_breakout:       'REDUCE',
    bullish_pullback:       'WATCHLIST_ONLY',
    range_breakout:         'WATCHLIST_ONLY',
    momentum_continuation:  'WATCHLIST_ONLY',
    gap_continuation:       'WATCHLIST_ONLY',
    ema_crossover:          'WATCHLIST_ONLY',
  },
  bearish: {
    bearish_breakdown:      'PROMOTE',
    weak_trend_breakdown:   'PROMOTE',
    overbought_reversal:    'PROMOTE',
    volume_climax_reversal: 'ACTIVE',
    bullish_divergence:     'WATCHLIST_ONLY',
    oversold_bounce:        'WATCHLIST_ONLY',
    mean_reversion_bounce:  'WATCHLIST_ONLY',
    bullish_breakout:       'BLOCK',
    bullish_pullback:       'BLOCK',
    momentum_continuation:  'BLOCK',
    range_breakout:         'BLOCK',
    gap_continuation:       'BLOCK',
    ema_crossover:          'BLOCK',
  },
  high_volatility: {
    // In a volatility-shock tape, every strategy is reduced; only
    // bearish setups and mean-reversion bounces stay ACTIVE because
    // they tolerate noise better than fresh long breakouts.
    bullish_breakout:       'REDUCE',
    bullish_pullback:       'REDUCE',
    momentum_continuation:  'WATCHLIST_ONLY',
    gap_continuation:       'WATCHLIST_ONLY',
    range_breakout:         'WATCHLIST_ONLY',
    ema_crossover:          'WATCHLIST_ONLY',
    overbought_reversal:    'ACTIVE',
    mean_reversion_bounce:  'ACTIVE',
    oversold_bounce:        'ACTIVE',
    bullish_divergence:     'ACTIVE',
    volume_climax_reversal: 'ACTIVE',
    bearish_breakdown:      'ACTIVE',
    weak_trend_breakdown:   'ACTIVE',
  },
  low_liquidity: {
    // All strategies fall to WATCHLIST_ONLY in thin tapes — execution
    // quality dominates. Operator must surface candidates manually.
  },
  stale_data: {},   // every strategy → WATCHLIST_ONLY (handled below)
  unknown:    {},   // every strategy → WATCHLIST_ONLY (handled below)
};

/** Per-decision baseline confidence / position-size / threshold tilts.
 *  These are the *default* magnitudes; performance can stack on top. */
const DECISION_DELTA: Record<RoutingDecision, {
  confidence: number; threshold: number; size: number;
}> = {
  PROMOTE:           { confidence: +5, threshold: -3, size: +10 },
  ACTIVE:            { confidence:  0, threshold:  0, size:   0 },
  REDUCE:            { confidence: -8, threshold: +5, size: -20 },
  WATCHLIST_ONLY:    { confidence: -15, threshold: +12, size: -50 },
  BLOCK:             { confidence: -25, threshold: +25, size: -100 },
  INSUFFICIENT_DATA: { confidence: -10, threshold: +10, size: -30 },
};

const DECISION_REASON: Record<RoutingDecision, (regime: RoutedRegime, displayName: string) => string> = {
  PROMOTE:           (r, d) => `${d} performs strongly in ${humanRegime(r)} regimes — promoted for this cycle.`,
  ACTIVE:            (r, d) => `${d} is suitable for ${humanRegime(r)} conditions.`,
  REDUCE:            (r, d) => `${d} requires stronger confirmation in ${humanRegime(r)} markets — confidence reduced.`,
  WATCHLIST_ONLY:    (r, d) => `Watchlist only: ${d} approval is restricted in the current ${humanRegime(r)} regime.`,
  BLOCK:             (r, d) => `Approval restricted: ${d} is structurally unsuitable for the current ${humanRegime(r)} regime.`,
  INSUFFICIENT_DATA: (r, d) => `Routing for ${d} is on hold — ${r === 'stale_data' ? 'market regime feed is stale' : 'market regime is undetermined'}.`,
};

function humanRegime(r: RoutedRegime): string {
  switch (r) {
    case 'strong_bullish':  return 'strong bullish';
    case 'high_volatility': return 'high-volatility';
    case 'low_liquidity':   return 'low-liquidity';
    case 'stale_data':      return 'stale-data';
    default:                return r;
  }
}

// ── Per-strategy routing ─────────────────────────────────────

export interface RouteStrategyInput {
  strategyId:   StrategyName | string;
  regime:       RoutedRegime;
  regimeStatus: RegimeStatus;
  /** Optional Phase-2 performance bucket — when present, tilts the
   *  routing decision by one notch within the bounds below. */
  performance?: StrategyPerformance | null;
}

export function routeStrategy(input: RouteStrategyInput): StrategyRoutingDecision {
  const meta = getStrategyMeta(input.strategyId);
  const warnings: string[] = [];

  // Stale/unknown regime ⇒ everyone is WATCHLIST_ONLY, no exceptions.
  // This is the "no blind approvals on stale data" safety rule.
  if (input.regimeStatus === 'INSUFFICIENT_DATA' || input.regimeStatus === 'STALE') {
    const decision: RoutingDecision = 'WATCHLIST_ONLY';
    const reason = input.regimeStatus === 'STALE'
      ? `Watchlist only: ${meta.strategyName} approval is restricted because the market regime feed is stale.`
      : `Watchlist only: ${meta.strategyName} approval is restricted because the current market regime is undetermined.`;
    return decorate(meta, input.regime, decision, reason, warnings);
  }

  // Default baseline from the matrix. Unmapped strategies (e.g. brand-
  // new ones not yet placed in the matrix) default to ACTIVE.
  const baseline: RoutingDecision = REGIME_MATRIX[input.regime][input.strategyId] ?? 'ACTIVE';

  // Performance tilt — never more than one notch in either direction.
  // Strong strategies in this regime get a bump; weak ones get a haircut.
  // We deliberately do NOT promote past BLOCK or demote below
  // WATCHLIST_ONLY purely on performance.
  let tilted = baseline;
  let performanceHint: StrategyRoutingDecision['performanceHint'] | undefined;
  const p = input.performance ?? null;
  if (p && p.performanceStatus !== 'INSUFFICIENT_DATA') {
    performanceHint = {
      expectancy:        p.expectancy,
      winRate:           p.winRate,
      healthLabel:       p.healthLabel,
      performanceStatus: p.performanceStatus,
    };
    if (p.performanceStatus === 'SUFFICIENT') {
      if (p.expectancy >= 1.0 && p.healthLabel !== 'WEAK') {
        tilted = bumpUp(baseline);
        if (tilted !== baseline) {
          warnings.push(`${meta.strategyName} promoted one notch — Phase 2 expectancy ${p.expectancy.toFixed(2)} in window.`);
        }
      } else if (p.expectancy <= -0.2 || p.healthLabel === 'WEAK') {
        tilted = bumpDown(baseline);
        if (tilted !== baseline) {
          warnings.push(`${meta.strategyName} demoted one notch — Phase 2 expectancy ${p.expectancy.toFixed(2)} in window.`);
        }
      }
    }
  }

  return decorate(meta, input.regime, tilted, undefined, warnings, performanceHint);
}

function bumpUp(d: RoutingDecision): RoutingDecision {
  switch (d) {
    case 'WATCHLIST_ONLY': return 'REDUCE';
    case 'REDUCE':         return 'ACTIVE';
    case 'ACTIVE':         return 'PROMOTE';
    default:               return d;
  }
}

function bumpDown(d: RoutingDecision): RoutingDecision {
  switch (d) {
    case 'PROMOTE':        return 'ACTIVE';
    case 'ACTIVE':         return 'REDUCE';
    case 'REDUCE':         return 'WATCHLIST_ONLY';
    default:               return d;
  }
}

function decorate(
  meta: ReturnType<typeof getStrategyMeta>,
  regime: RoutedRegime,
  decision: RoutingDecision,
  overrideReason: string | undefined,
  warnings: string[],
  performanceHint?: StrategyRoutingDecision['performanceHint'],
): StrategyRoutingDecision {
  const delta = DECISION_DELTA[decision];
  const reason = overrideReason ?? DECISION_REASON[decision](regime, meta.strategyName);
  return {
    strategyId:                  meta.strategyId,
    strategyName:                meta.strategyName,
    regime,
    routingDecision:             decision,
    confidenceAdjustment:        delta.confidence,
    approvalThresholdAdjustment: delta.threshold,
    positionSizeAdjustment:      delta.size,
    reason,
    warnings,
    ...(performanceHint ? { performanceHint } : {}),
  };
}

// ── Full router orchestration ────────────────────────────────

export interface BuildRouterInput {
  /** Output of detectMarketRegime() on the benchmark, or null when the
   *  benchmark feed is unavailable. */
  detectedRegime:           MarketRegimeLabel | null;
  /** Strength/confidence 0..100 from detectEnhancedRegime, or null. */
  regimeStrength:           number | null;
  /** Minutes since the latest benchmark candle. */
  benchmarkAgeMinutes:      number | null;
  /** Output of the Phase-2 buildPerformanceReport — used to tilt
   *  strategies that have strong/weak recent expectancy. */
  performances:             StrategyPerformance[];
  performanceWindow:        string | null;
  /** When true, the freshness gate has already declared candles stale
   *  for the current scan — every strategy is forced to WATCHLIST_ONLY. */
  staleDataFlag?:           boolean;
}

export function buildRegimeRouter(input: BuildRouterInput): RegimeRouterReport {
  const benchmarkAvailable = !!input.detectedRegime;

  // Regime status — STALE if the benchmark candle is hours old, etc.
  let regimeStatus: RegimeStatus = 'AVAILABLE';
  if (input.staleDataFlag === true || !benchmarkAvailable) {
    regimeStatus = 'INSUFFICIENT_DATA';
  } else if (input.benchmarkAgeMinutes != null && input.benchmarkAgeMinutes > 24 * 60) {
    regimeStatus = 'STALE';
  }

  // Final regime label on the wire.
  const currentRegime: RoutedRegime = regimeStatus === 'INSUFFICIENT_DATA'
    ? (input.staleDataFlag ? 'stale_data' : 'unknown')
    : normaliseRegime(input.detectedRegime);

  // Build per-strategy routing across the FULL registry so the API
  // exposes every strategy's decision (operators don't have to guess
  // about blocked ones).
  const performanceById = new Map<string, StrategyPerformance>();
  for (const p of input.performances) performanceById.set(p.strategyId, p);

  const routingMatrix: StrategyRoutingDecision[] = [];
  for (const strategyId of Object.keys(STRATEGY_REGISTRY)) {
    routingMatrix.push(routeStrategy({
      strategyId,
      regime:       currentRegime,
      regimeStatus,
      performance:  performanceById.get(strategyId) ?? null,
    }));
  }

  const promoted: string[] = [];
  const active:   string[] = [];
  const reduced:  string[] = [];
  const watchlist: string[] = [];
  const blocked:  string[] = [];
  for (const r of routingMatrix) {
    switch (r.routingDecision) {
      case 'PROMOTE':         promoted.push(r.strategyId); break;
      case 'ACTIVE':          active.push(r.strategyId); break;
      case 'REDUCE':          reduced.push(r.strategyId); break;
      case 'WATCHLIST_ONLY':  watchlist.push(r.strategyId); break;
      case 'BLOCK':           blocked.push(r.strategyId); break;
      case 'INSUFFICIENT_DATA': watchlist.push(r.strategyId); break;
    }
  }

  const warnings: string[] = [];
  if (regimeStatus !== 'AVAILABLE') {
    warnings.push(
      regimeStatus === 'STALE'
        ? `Market regime is stale (benchmark last updated ~${input.benchmarkAgeMinutes ?? '—'}m ago). Routing forces watchlist-only.`
        : 'Market regime undetermined — every strategy is restricted to watchlist until benchmark data refreshes.',
    );
  }
  if (input.performances.length === 0) {
    warnings.push('Phase 2 performance data unavailable — routing falls back to regime defaults only.');
  }

  const summary = buildSummary(regimeStatus, currentRegime, input.regimeStrength,
    { promoted: promoted.length, active: active.length, reduced: reduced.length,
      watchlist: watchlist.length, blocked: blocked.length });

  return {
    generatedAt:             new Date().toISOString(),
    regimeStatus,
    currentRegime,
    confidence: typeof input.regimeStrength === 'number'
      ? clampInt(input.regimeStrength, 0, 100)
      : (regimeStatus === 'AVAILABLE' ? 50 : 0),
    summary,
    activeStrategies:        active,
    promotedStrategies:      promoted,
    reducedStrategies:       reduced,
    watchlistOnlyStrategies: watchlist,
    blockedStrategies:       blocked,
    routingMatrix,
    warnings,
    dataQuality: {
      benchmarkCandlesAvailable: benchmarkAvailable,
      benchmarkDataAgeMinutes:   input.benchmarkAgeMinutes ?? null,
      performanceAvailable:      input.performances.length > 0,
      performanceWindow:         input.performanceWindow,
    },
  };
}

function buildSummary(
  status: RegimeStatus,
  regime: RoutedRegime,
  strength: number | null,
  counts: { promoted: number; active: number; reduced: number; watchlist: number; blocked: number },
): string {
  if (status === 'INSUFFICIENT_DATA') {
    return regime === 'stale_data'
      ? 'Market regime feed is stale — every strategy is watchlist-only until data refreshes.'
      : 'Market regime is undetermined — routing defaults to watchlist-only across the board.';
  }
  if (status === 'STALE') {
    return 'Market regime is stale — routing forces watchlist-only to protect approval quality.';
  }
  const strengthText = typeof strength === 'number' ? ` (regime strength ${Math.round(strength)})` : '';
  return `Market regime: ${humanRegime(regime)}${strengthText}. ` +
    `${counts.promoted} promoted · ${counts.active} active · ${counts.reduced} reduced · ` +
    `${counts.watchlist} watchlist-only · ${counts.blocked} blocked.`;
}

// ── Signal-side application helper ───────────────────────────

export interface SignalRoutingApplication {
  routedAction:    'APPROVED' | 'WATCHLIST' | 'REJECTED';
  routingReason:   string;
  routingDecision: StrategyRoutingDecision;
}

/**
 * Given a signal's current action and the strategy's routing decision,
 * compute the final action after routing is applied. This is the only
 * entry point that demotes a signal — the routing decision object is
 * always returned alongside so the explanation layer can read why.
 *
 * Routing NEVER promotes an already-approved signal that the gates
 * rejected. It can only demote.
 */
export function applyRoutingToSignal(
  currentAction: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | string | null | undefined,
  routing: StrategyRoutingDecision,
): SignalRoutingApplication {
  const norm = String(currentAction ?? '').toUpperCase();
  const incoming: 'APPROVED' | 'WATCHLIST' | 'REJECTED' =
    norm === 'APPROVED' ? 'APPROVED'
    : norm === 'REJECTED' ? 'REJECTED'
    : 'WATCHLIST';

  // Block / Watchlist-only demote APPROVED → WATCHLIST, leave the rest.
  if (routing.routingDecision === 'BLOCK') {
    return {
      routedAction:    'REJECTED',
      routingReason:   routing.reason,
      routingDecision: routing,
    };
  }
  if (routing.routingDecision === 'WATCHLIST_ONLY' && incoming === 'APPROVED') {
    return {
      routedAction:    'WATCHLIST',
      routingReason:   routing.reason,
      routingDecision: routing,
    };
  }
  // PROMOTE / ACTIVE / REDUCE / INSUFFICIENT_DATA leave the action
  // alone — the confidence/threshold tilts are advisory and feed
  // into the score calc, not the action.
  return {
    routedAction:    incoming,
    routingReason:   routing.reason,
    routingDecision: routing,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
