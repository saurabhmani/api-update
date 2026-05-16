// ════════════════════════════════════════════════════════════════
//  Signal Maturity Worker
//
//  Runs at ~60s cadence. Walks every non-promoted, non-terminated
//  row in q365_signal_maturity_tracker, recomputes maturity from
//  the latest matching row in q365_signals, persists score + stage,
//  and promotes mature rows into q365_confirmed_signal_snapshots
//  when the cycle / age / score / stability thresholds all pass.
//
//  This is the ONLY path that creates confirmed snapshots. The
//  scanner's saveSignals never inserts directly anymore — every
//  detection enters the tracker, ages across cycles, and is
//  promoted (or not) by this worker.
//
//  Design principle (from the spec): an experienced trader. Be
//  patient. Be trustworthy. Don't promote a signal until you've
//  watched it stand still through several scanner cycles.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  scoreMaturity,
  isPromotable,
  promotionRulesForStrategy,
  type MaturityScorerOutput,
} from '@/lib/signal-engine/maturity/maturityScorer';
import {
  getActiveTrackers,
  updateMaturityState,
  markPromoted,
  upsertTrackerOnDetection,
  type TrackerRow,
} from '@/lib/signal-engine/repository/maturityTracker';
import { insertConfirmedSnapshotIfEligible } from '@/lib/signal-engine/repository/confirmedSnapshots';
import { getMarketStatus } from '@/lib/marketData/marketHours';
// Step 8 note: this worker must NEVER call resolveBatch /
// resolvePrices. Data-quality gating is done by reading the
// q365_data_feed_health audit table instead — a pure DB lookup.

interface CurrentSignalRow {
  id:                  number;
  symbol:              string;
  direction:           string;
  entry_price:         string | number;
  stop_loss:           string | number;
  target1:             string | number;
  target2:             string | number | null;
  confidence_score:    number;
  final_score:         string | number | null;
  composite_final_score: string | number | null;
  decay_state:         string | null;
  classification:      string | null;
  factor_scores_json:  unknown;
  market_regime:       string | null;
  market_stance:       string | null;
  pct_change:          string | number | null;
  scenario_tag:        string | null;
  signal_status:       string | null;
  live_valid:          number | null;
  rejection_codes_json: unknown;
  rejection_reasons_json: unknown;
  stress_survival_score: string | number | null;
  explanation_json:    unknown;
  risk_score:          number | null;
  risk_reward:         string | number | null;
  confidence_band:     string | null;
}

export interface MaturityRunResult {
  scanned:     number;
  promoted:    number;
  matured:     number;     // reached score≥85 but not yet eligible (cycles/age short)
  developing:  number;
  candidate:   number;
  /** Rejected by the hard market-regime gate even though scoring qualified. */
  regime_blocked: number;
  failed:      number;
  elapsedMs:   number;
}

/**
 * Hard market-regime gate. Soft regime alignment is already a
 * scoring factor; this check is the AND-style veto on top — a
 * mature, well-scored, stable signal still does not get confirmed
 * if it meaningfully fights the prevailing regime.
 *
 * Threshold = 0.5. Reference points from scoreRegimeAlignment:
 *   BUY  in BULL/STRONG_BULL    ≥ 0.85   (passes)
 *   BUY  in NEUTRAL             0.55    (passes)
 *   BUY  in BEAR                0.30    (rejected)
 *   BUY  in STRONG_BEAR         0.10    (rejected)
 *   SELL is the mirror.
 *
 * Rationale: an "experienced trader" doesn't take counter-regime
 * trades on a confirmed-snapshot bar — those are the trades most
 * likely to fail even when every other gate is green.
 */
const REGIME_GATE_THRESHOLD = 0.5;
function passesRegimeGate(result: MaturityScorerOutput): boolean {
  const factor = result.factors.find((f) => f.name === 'regime_alignment');
  if (!factor) return true;        // factor missing — fail-open (don't break promotion)
  return factor.raw >= REGIME_GATE_THRESHOLD;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseObj(v: unknown): Record<string, number> | null {
  if (!v) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, number>
        : null;
    } catch { return null; }
  }
  return null;
}
function parseStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }
  return [];
}

/**
 * Pulls the latest active q365_signals row for a (symbol, direction)
 * pair. Returns null when nothing matches — caller should skip the
 * tracker until next cycle (the scanner may have expired the row).
 */
async function fetchCurrentSignalRow(
  symbol: string,
  direction: 'BUY' | 'SELL',
): Promise<CurrentSignalRow | null> {
  try {
    const result = await db.query<CurrentSignalRow>(
      `SELECT id, symbol, direction,
              entry_price, stop_loss, target1, target2,
              confidence_score, final_score, composite_final_score,
              decay_state, classification,
              factor_scores_json, market_regime, market_stance,
              pct_change, scenario_tag, signal_status,
              live_valid, rejection_codes_json, rejection_reasons_json,
              stress_survival_score, explanation_json,
              risk_score, risk_reward, confidence_band
         FROM q365_signals
        WHERE symbol = ?
          AND direction = ?
          AND status IN ('active','watchlist','flagged')
          AND (invalidation_reason IS NULL
               OR invalidation_reason NOT IN (
                 'stop_loss_broken','stop_loss_broken_confirmed',
                 'target_reached','target_already_reached',
                 'engine_disagree','live_rejected'
               ))
          AND (expires_at IS NULL OR expires_at > NOW())
          AND decay_state <> 'expired'
        ORDER BY generated_at DESC
        LIMIT 1`,
      [symbol.toUpperCase(), direction],
    );
    return ((result.rows as CurrentSignalRow[])[0]) ?? null;
  } catch (err: any) {
    console.warn(`[signalMaturity] fetch row for ${symbol} ${direction} failed:`, err?.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  MATURATION_AUDIT_2026-05 — per-cycle audit ring buffer
//
//  Each processTracker call pushes a structured snapshot of the
//  maturity result + dominant blocker into this array; runMaturity
//  reads it at the end of the cycle and emits [MATURITY_BLOCKERS]
//  with top-30-by-score + a cause histogram so the operator can see
//  exactly which gate is keeping rows from promoting.
//
//  Cleared at the START of every runMaturity call so each cycle
//  reports its own data.
// ════════════════════════════════════════════════════════════════
interface MaturityAuditRow {
  symbol:         string;
  direction:      string;
  score:          number;
  stage:          string;
  cycles:         number;
  age_min:        number;
  confidence:     number;
  rr:             number;
  stability_raw:  number;
  stable:         boolean;
  conviction:     string | null;
  classification: string | null;
  blocker:        string;
  factor_breakdown: Array<{ name: string; raw: number; contribution: number }>;
}
const _maturityAudit: MaturityAuditRow[] = [];
// Audit-only threshold — read once so the reporting layer doesn't
// have to re-pull from env on every cycle. Mirrors the maturity
// scorer's effective threshold (env: MATURITY_MATURE_THRESHOLD,
// default 75 after MATURATION_AUDIT_2026-05).
const STAGE_MATURE_THRESHOLD_FOR_AUDIT = (() => {
  const raw = Number(process.env.MATURITY_MATURE_THRESHOLD);
  if (!Number.isFinite(raw)) return 75;
  return Math.max(60, Math.min(100, raw));
})();
function pushMaturityAudit(row: MaturityAuditRow): void {
  _maturityAudit.push(row);
  // Cap at 1000 entries to bound memory if a deployment somehow runs
  // an unbounded number of trackers in a single cycle.
  if (_maturityAudit.length > 1000) _maturityAudit.shift();
}

/**
 * One tracker → one decision. Recomputes maturity, persists state,
 * and promotes when eligible. Returns a stage tag for accounting.
 */
async function processTracker(
  tracker: TrackerRow,
): Promise<'promoted' | 'matured' | 'developing' | 'candidate' | 'skipped' | 'regime_blocked'> {
  const current = await fetchCurrentSignalRow(tracker.symbol, tracker.direction);
  if (!current) {
    // Scanner expired the underlying signal between detection and
    // this tick. Leave the tracker untouched — the next detection
    // will reset it via the stale-tracker rule.
    return 'skipped';
  }

  // ════════════════════════════════════════════════════════════════
  // MATURITY_CYCLE_TICK_2026-05 — cron-driven cycle accumulation.
  //
  // Architectural fix: previously, validation_cycles_passed was bumped
  // ONLY when saveSignals re-emitted a fresh signal for the same
  // (symbol, direction). But Phase 4 strategy detection only fires on
  // FRESH setups — a breakout that triggered yesterday won't be
  // re-emitted today even if the trade is still valid. Result:
  // trackers were created at cycles=1 by saveSignals on first
  // detection, then never bumped — operator saw 33h-old trackers
  // permanently stuck at cycles=1 with `[CYCLE_ACCUMULATION]` logs
  // never appearing because upsertTrackerOnDetection was never called
  // again.
  //
  // Fix: the maturity cron is the natural cycle counter — it iterates
  // over every active tracker on every tick and ALREADY confirms the
  // signal is still alive (fetchCurrentSignalRow succeeded above).
  // Each successful processTracker observation IS a validation cycle.
  // We call upsertTrackerOnDetection here to bump cycles + append to
  // history, rate-limited to MATURITY_CYCLE_MIN_MINUTES (default 5)
  // so cron-tick frequency doesn't runaway-bump cycles every 60s.
  //
  // Promoted / terminated trackers are skipped: the active confirmed
  // snapshot is the source of truth post-promotion, and a terminated
  // lifecycle should not accrue more cycles.
  //
  // Set MATURITY_CYCLE_MIN_MINUTES=0 to disable the rate-limit (every
  // tick bumps); set very high (e.g., 60) to slow accumulation. Set
  // MATURITY_CRON_BUMP_DISABLED=1 to disable the cron-tick bump
  // entirely and revert to the legacy "saveSignals-only" semantic.
  // ════════════════════════════════════════════════════════════════
  const cronBumpDisabled = process.env.MATURITY_CRON_BUMP_DISABLED === '1';
  const cycleMinMinutes  = (() => {
    const raw = Number(process.env.MATURITY_CYCLE_MIN_MINUTES);
    if (!Number.isFinite(raw) || raw < 0) return 5;
    return Math.min(120, raw);
  })();
  const minutesSinceLastSeen = (Date.now() - tracker.last_seen_at) / 60_000;
  const eligibleForCronBump =
    !cronBumpDisabled
    && minutesSinceLastSeen >= cycleMinMinutes
    && tracker.stage !== 'promoted'
    && tracker.stage !== 'terminated';
  if (eligibleForCronBump) {
    try {
      const bumpResult = await upsertTrackerOnDetection({
        symbol:      tracker.symbol,
        direction:   tracker.direction,
        signal_id:   Number(current.id),
        entry_price: num(current.entry_price),
        stop_loss:   num(current.stop_loss),
        target1:     num(current.target1),
        confidence:  num(current.confidence_score),
        final_score: numOrNull(current.final_score),
        decay_state: current.decay_state ?? null,
      });
      console.log(
        `[CRON_TICK_BUMP] symbol=${tracker.symbol} dir=${tracker.direction} ` +
        `prev_cycles=${tracker.validation_cycles_passed} new_cycles=${bumpResult.cycles} ` +
        `since_last_seen=${minutesSinceLastSeen.toFixed(1)}min ` +
        `min_interval=${cycleMinMinutes}min ` +
        `reset=${bumpResult.reset} reason=${bumpResult.resetReason}`,
      );
      // Mutate the local tracker so downstream scoreMaturity / promotion
      // sees the bumped cycle count THIS tick (not next tick). History
      // is also appended in upsertTrackerOnDetection; we leave the local
      // history reference unchanged because scoreMaturity treats history
      // length defensively (single-cycle defaults to stable=false even
      // if length grows mid-call). Next tick's getActiveTrackers re-read
      // pulls the full updated history from DB.
      tracker.validation_cycles_passed = bumpResult.cycles;
      tracker.last_seen_at             = Date.now();
      if (bumpResult.reset) {
        // A reset wipes history back to a single snapshot. Reflect that
        // in the local view so this tick's stability scoring is honest.
        tracker.history = [];
      }
    } catch (err: any) {
      console.warn(
        `[signalMaturity] cron-tick bump failed for ${tracker.symbol} ${tracker.direction}: ${err?.message}`,
      );
    }
  } else if (!cronBumpDisabled) {
    // Diagnostic: row was eligible by stage but rate-limited. Helps the
    // operator confirm the cron is RUNNING but hasn't bumped yet.
    console.log(
      `[CRON_TICK_BUMP] symbol=${tracker.symbol} dir=${tracker.direction} ` +
      `skipped reason=${
        tracker.stage === 'promoted' ? 'promoted_dormant' :
        tracker.stage === 'terminated' ? 'terminated' :
        `rate_limited (since_last_seen=${minutesSinceLastSeen.toFixed(1)}min < ${cycleMinMinutes}min)`
      }`,
    );
  }

  const factorScores = parseObj(current.factor_scores_json);

  const result: MaturityScorerOutput = scoreMaturity({
    symbol:    tracker.symbol,
    direction: tracker.direction,
    current: {
      entry_price:    num(current.entry_price),
      stop_loss:      num(current.stop_loss),
      target1:        num(current.target1),
      confidence:     num(current.confidence_score),
      final_score:    numOrNull(current.final_score),
      decay_state:    current.decay_state,
      classification: current.classification,
      factor_scores:  factorScores,
      market_regime:  current.market_regime,
      pct_change:     numOrNull(current.pct_change),
      news_shock:     null,
    },
    tracker: {
      first_detected_at: tracker.first_detected_at,
      last_seen_at:      tracker.last_seen_at,
      cycles:            tracker.validation_cycles_passed,
      history:           tracker.history,
    },
  });

  // Persist maturity state regardless of promotion outcome.
  await updateMaturityState(tracker.id, {
    score:           result.score,
    stage:           result.stage,
    stable:          result.stable,
    convictionLevel: result.convictionLevel,
    factors:         result.factors,
  });

  // Spec INSTITUTIONAL §I — per-tracker promotion-score visibility.
  // MATURATION_AUDIT_2026-05 — log enhanced with full breakdown so the
  // operator can answer "why is this tracker stuck at score=45?"
  // without spelunking. Fields shown:
  //   score          composite maturity score (0-100)
  //   stage          candidate / developing / mature
  //   cycles         validation cycles observed
  //   age_min        minutes since first_detected_at
  //   stable         hard boolean (drift within tolerance both axes)
  //   stability_raw  smooth raw score that drives the new lenient
  //                  promotion gate (≥ STABILITY_RAW_PROMOTION_FLOOR)
  //   conf           confidence_score from current signal row
  //   rr             risk_reward from current signal row
  //   conviction     INSTITUTIONAL / HIGH / MEDIUM
  //   blocker        first reason from result.reasons[] — the
  //                  single dominant graduation blocker.
  const stabilityFactor = result.factors.find((f) => f.name === 'stability');
  const stabilityRaw = stabilityFactor?.raw ?? 0;
  const conf = num(current.confidence_score);
  const rr   = num(current.risk_reward);
  console.log(
    `[PROMOTION_SCORE] symbol=${tracker.symbol} dir=${tracker.direction} ` +
    `score=${result.score.toFixed(1)} stage=${result.stage} ` +
    `cycles=${tracker.validation_cycles_passed} ` +
    `age_min=${result.signalAgeMinutes} ` +
    `conf=${conf.toFixed(0)} rr=${rr.toFixed(2)} ` +
    `stability_raw=${stabilityRaw.toFixed(2)} ` +
    `stable=${result.stable} ` +
    `conviction=${result.convictionLevel ?? 'null'} ` +
    `blocker="${result.reasons?.[0] ?? 'none'}"`,
  );
  console.log(
    `[STABILITY_RESULT] symbol=${tracker.symbol} dir=${tracker.direction} ` +
    `stable=${result.stable} stability_raw=${stabilityRaw.toFixed(2)} ` +
    `reason="${result.reasons?.[0] ?? 'n/a'}"`,
  );

  // MATURATION_AUDIT_2026-05 — push to module-level ring buffer so the
  // worker can emit a [MATURITY_BLOCKERS] aggregate at end of the run
  // showing top-30 strongest non-promoted rows + cause histogram.
  pushMaturityAudit({
    symbol:           tracker.symbol,
    direction:        tracker.direction,
    score:            result.score,
    stage:            result.stage,
    cycles:           tracker.validation_cycles_passed,
    age_min:          result.signalAgeMinutes,
    confidence:       conf,
    rr,
    stability_raw:    stabilityRaw,
    stable:           result.stable,
    conviction:       result.convictionLevel ?? null,
    classification:   current.classification ?? null,
    blocker:          result.reasons?.[0] ?? 'none',
    factor_breakdown: result.factors.map((f) => ({
      name:         f.name,
      raw:          Math.round(f.raw * 100) / 100,
      contribution: Math.round(f.contribution * 100) / 100,
    })),
  });

  // Strategy-specific seasoning floor (BREAKOUT 15m / PULLBACK 25m
  // / MEAN_REVERSION 35m / others 10m). The maturity scorer can't
  // know the strategy without coupling, so we resolve the rules
  // here from the q365_signals.scenario_tag column.
  const rules = promotionRulesForStrategy(current.scenario_tag);
  if (!isPromotable(result, tracker.validation_cycles_passed, rules)) {
    if (result.stage === 'mature')      return 'matured';
    if (result.stage === 'developing')  return 'developing';
    return 'candidate';
  }

  // Hard market-regime gate. The scoring layer already factored
  // regime alignment in (weight 0.08), but the user requirement is
  // a HARD veto: a counter-regime signal must not become a
  // confirmed snapshot even if every other dimension is excellent.
  if (!passesRegimeGate(result)) {
    const factor = result.factors.find((f) => f.name === 'regime_alignment');
    console.warn(
      `[REGIME_VETO] symbol=${tracker.symbol} dir=${tracker.direction} ` +
      `regime_factor=${factor?.raw ?? 'null'} threshold=${REGIME_GATE_THRESHOLD} ` +
      `rejected="counter-regime trade"`,
    );
    return 'regime_blocked';
  }

  // Eligible — try to insert the confirmed snapshot. The writer has
  // its own gate stack (rejection codes, live_valid, rr/conf/edge
  // floor, duplicate-active check); a refusal here is honest — the
  // signal isn't ready even though maturity says yes.
  //
  // MATURATION_AUDIT_2026-05 — institutional score, not the decayed
  // dynamic-ranker score, is what the promotion / strict gate compares
  // against. Two columns coexist on q365_signals:
  //   - final_score          → dynamic ranker (decays via freshness +
  //                            stepAge + overextension penalties; drops
  //                            ~25-35 points across 18 cycles).
  //   - composite_final_score → Phase-4 calculateFinalScore (does NOT
  //                            decay; 0-100 institutional structural
  //                            quality).
  // The institutional MIN_FINAL_SCORE / STRICT_FINAL_FLOOR (60) is
  // calibrated against the un-decaying composite scale. Passing the
  // decayed dynamic value here was the dominant cause of mature/stable
  // rows getting stuck at "Awaiting Confirmation": confidence=79 with a
  // healthy Phase-4 composite would still fail because final_score had
  // bled to ~47 by the time cycles=3+ accumulated. Prefer the composite
  // when present; fall back to dynamic for legacy rows whose Phase-4
  // column was never populated.
  const institutionalFinalScore =
    numOrNull(current.composite_final_score) ?? numOrNull(current.final_score);
  const insert = await insertConfirmedSnapshotIfEligible({
    source_signal_id:  current.id,
    symbol:            tracker.symbol,
    exchange:          'NSE',
    direction:         tracker.direction,
    strategy:          current.scenario_tag ?? null,
    entry_price:       num(current.entry_price),
    stop_loss:         num(current.stop_loss),
    target1:           num(current.target1),
    target2:           current.target2 != null ? num(current.target2) : null,
    confidence_score:  num(current.confidence_score),
    final_score:       institutionalFinalScore,
    classification:    current.classification,
    signal_status:     current.signal_status ?? 'APPROVED_SIGNAL',
    live_valid:        current.live_valid == null ? null : Number(current.live_valid) === 1,
    factor_scores:     factorScores,
    explanation:       current.explanation_json ?? null,
    gate_details: {
      rejection_codes:        parseStringArray(current.rejection_codes_json),
      rejection_reasons:      parseStringArray(current.rejection_reasons_json),
      risk_reward:            numOrNull(current.risk_reward),
      risk_score:             current.risk_score,
      confidence_band:        current.confidence_band,
      regime:                 current.market_regime,
      market_stance:          current.market_stance,
      maturity_reasons:       result.reasons,
    },
    rejection_codes:    parseStringArray(current.rejection_codes_json),
    stress_survival_score: numOrNull(current.stress_survival_score),

    // Maturity layer — frozen with the snapshot.
    maturity_score:                  result.score,
    validation_cycles_passed:        tracker.validation_cycles_passed,
    signal_age_minutes_at_promotion: result.signalAgeMinutes,
    conviction_level:                result.convictionLevel,
    stability_passed:                result.stable,
    maturity_factors:                result.factors,
  });

  if (insert.inserted && insert.snapshot_id) {
    await markPromoted(tracker.id, insert.snapshot_id);
    console.log(
      `[signalMaturity] PROMOTED ${tracker.symbol} ${tracker.direction} ` +
      `score=${result.score} cycles=${tracker.validation_cycles_passed} ` +
      `age=${result.signalAgeMinutes}m → snapshot=${insert.snapshot_id}`,
    );
    // Spec INSTITUTIONAL §I — single greppable approval marker. Operator
    // greps `[FINAL_APPROVAL]` for the canonical "this row landed in
    // confirmed snapshots" event. Pairs with [PERSIST_SUCCESS] from
    // the writer (same id) so the audit trail is complete.
    console.log(
      `[FINAL_APPROVAL] symbol=${tracker.symbol} dir=${tracker.direction} ` +
      `snapshot_id=${insert.snapshot_id} ` +
      `score=${result.score.toFixed(1)} cycles=${tracker.validation_cycles_passed} ` +
      `conviction=${result.convictionLevel ?? 'null'} ` +
      `confidence=${num(current.confidence_score)} ` +
      `final_score_dynamic=${numOrNull(current.final_score) ?? 'null'} ` +
      `final_score_institutional=${institutionalFinalScore ?? 'null'} ` +
      `cls=${current.classification ?? 'null'}`,
    );
    return 'promoted';
  }

  // Insert refused. Common reasons: duplicate_active (a previous
  // snapshot for the same (symbol, direction) is still valid — the
  // tracker shouldn't fire again until that one terminates), or
  // a writer gate the row didn't pass. Stay 'mature' on the tracker
  // and try again on the next worker tick.
  return 'matured';
}

// ── DQ + freshness gate (calibrated 2026-05) ─────────────────────
//
// Spec INSTITUTIONAL §I — pure-DB data-quality probe. Tiered: feed-
// health primary, candle freshness fallback, open-by-default safety
// net. The output envelope carries every field the operator asked
// for in the [DATA_QUALITY] / [FRESHNESS_GATE] / [PROMOTION_BLOCK]
// log lines so a single helper covers the audit surface.

interface MaturityDqDecision {
  allowPromotion:        boolean;
  mode:                  'disabled' | 'feed_health' | 'candle_fallback' | 'open_default';
  feedHealthDq:          string;       // '' | 'LOW' | 'MEDIUM' | 'HIGH'
  feedHealthAgeMin:      number | null;
  candleAgeMin:          number | null;
  candleAgeOk:           boolean;
  candleFreshLimitMin:   number;
  latestCandleTs:        string | null;
  marketOpen:            boolean;
  reason:                string;
  dqReason:              string;
  degradedReason:        string | null;
  suggestion:            string;
}

function envInt(name: string, fallback: number, lo: number, hi: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

async function evaluateMaturityDqGate(): Promise<MaturityDqDecision> {
  // Operator escape: full bypass.
  if ((process.env.MATURITY_DQ_GATE ?? '').trim().toLowerCase() === 'disabled') {
    return {
      allowPromotion: true, mode: 'disabled',
      feedHealthDq: '', feedHealthAgeMin: null,
      candleAgeMin: null, candleAgeOk: true,
      candleFreshLimitMin: 0, latestCandleTs: null,
      marketOpen: false,
      reason: 'MATURITY_DQ_GATE=disabled', dqReason: 'bypassed',
      degradedReason: null,
      suggestion: 'unset MATURITY_DQ_GATE to re-enable the gate',
    };
  }

  const marketStatus  = getMarketStatus();
  const marketOpen    = marketStatus.isOpen;
  const feedWindowMin = envInt('MATURITY_DQ_FRESH_WINDOW_MIN', 10, 1, 240);
  const candleLimitOpen   = envInt('MATURITY_CANDLE_FRESH_MIN',        6 * 60,  60, 7 * 24 * 60);
  const candleLimitClosed = envInt('MATURITY_CANDLE_FRESH_CLOSED_MIN', 48 * 60, 60, 14 * 24 * 60);
  const candleFreshLimit  = marketOpen ? candleLimitOpen : candleLimitClosed;

  // ── Tier 1: feed-health probe ──
  let feedHealthDq      = '';
  let feedHealthAgeMin: number | null = null;
  try {
    const { rows } = await db.query<{
      data_quality:         string | null;
      response_received_at: Date | string;
    }>(
      `SELECT data_quality, response_received_at
         FROM q365_data_feed_health
        WHERE status IN ('success','partial')
          AND response_received_at > (NOW() - INTERVAL ? MINUTE)
        ORDER BY id DESC
        LIMIT 1`,
      [feedWindowMin],
    );
    const latest = (rows as any[])[0];
    feedHealthDq = String(latest?.data_quality ?? '').toUpperCase();
    if (latest?.response_received_at) {
      const ts = latest.response_received_at instanceof Date
        ? latest.response_received_at.getTime()
        : Date.parse(String(latest.response_received_at));
      if (Number.isFinite(ts)) {
        feedHealthAgeMin = Math.round((Date.now() - ts) / 60_000);
      }
    }
  } catch {
    // table missing on fresh deploy — fall through to candle probe.
  }

  // Hard veto: feed-health explicitly says LOW. Trust the upstream.
  if (feedHealthDq === 'LOW') {
    return {
      allowPromotion: false, mode: 'feed_health',
      feedHealthDq, feedHealthAgeMin,
      candleAgeMin: null, candleAgeOk: false,
      candleFreshLimitMin: candleFreshLimit,
      latestCandleTs: null, marketOpen,
      reason: `feed-health LOW (age ${feedHealthAgeMin ?? '?'}min) — upstream provider quality degraded`,
      dqReason: 'feed_health=LOW',
      degradedReason: 'recent provider call returned LOW data quality',
      suggestion: 'wait for provider quality to recover OR set MATURITY_DQ_GATE=disabled',
    };
  }

  // Allow path 1: feed-health is recent + non-LOW.
  if (feedHealthDq && feedHealthDq !== 'LOW') {
    return {
      allowPromotion: true, mode: 'feed_health',
      feedHealthDq, feedHealthAgeMin,
      candleAgeMin: null, candleAgeOk: true,
      candleFreshLimitMin: candleFreshLimit,
      latestCandleTs: null, marketOpen,
      reason: `feed-health ${feedHealthDq} (age ${feedHealthAgeMin}min) — upstream healthy`,
      dqReason: `feed_health=${feedHealthDq}`,
      degradedReason: null,
      suggestion: '',
    };
  }

  // ── Tier 2: candle-freshness fallback ──
  // Feed-health was empty / outside the window. Fall through to the
  // canonical data signal: are the bars in market_data_daily recent?
  let candleAgeMin: number | null = null;
  let latestCandleTs: string | null = null;
  try {
    const { rows } = await db.query<{ latest: Date | string | null }>(
      `SELECT MAX(ts) AS latest FROM market_data_daily`,
    );
    const latest = rows[0]?.latest;
    if (latest) {
      latestCandleTs = latest instanceof Date ? latest.toISOString() : String(latest);
      const ts = Date.parse(latestCandleTs);
      if (Number.isFinite(ts)) {
        candleAgeMin = Math.round((Date.now() - ts) / 60_000);
      }
    }
  } catch {
    // table missing — fall through to open-default tier.
  }

  if (candleAgeMin != null) {
    const ok = candleAgeMin <= candleFreshLimit;
    return {
      allowPromotion: ok, mode: 'candle_fallback',
      feedHealthDq: '', feedHealthAgeMin,
      candleAgeMin, candleAgeOk: ok,
      candleFreshLimitMin: candleFreshLimit,
      latestCandleTs, marketOpen,
      reason: ok
        ? `feed-health empty; candle ${candleAgeMin}min ≤ ${candleFreshLimit}min cap (market ${marketOpen ? 'open' : 'closed'})`
        : `feed-health empty AND candle ${candleAgeMin}min > ${candleFreshLimit}min cap — refusing to promote stale data`,
      dqReason: ok ? 'candle_fallback=OK' : 'candle_fallback=STALE',
      degradedReason: ok
        ? null
        : `bars in market_data_daily are ${candleAgeMin}min old (limit ${candleFreshLimit}min)`,
      suggestion: ok
        ? ''
        : `run candle ingestion (POST /api/run-signal-engine?force=true) OR raise MATURITY_CANDLE_FRESH_${marketOpen ? '' : 'CLOSED_'}MIN`,
    };
  }

  // ── Tier 3: open by default ──
  // Both probes empty — fresh deploy, empty audit table, no candles
  // yet. The original code blocked here; spec INSTITUTIONAL §I now
  // allows promotion with a loud warning so the operator can see
  // promotion is happening on degraded telemetry.
  return {
    allowPromotion: true, mode: 'open_default',
    feedHealthDq: '', feedHealthAgeMin: null,
    candleAgeMin: null, candleAgeOk: false,
    candleFreshLimitMin: candleFreshLimit,
    latestCandleTs: null, marketOpen,
    reason: 'feed-health AND candle-freshness probes both empty — open-default',
    dqReason: 'no_telemetry_yet',
    degradedReason: 'q365_data_feed_health AND market_data_daily both empty',
    suggestion: 'expected on first deploy; telemetry will populate after the first candle refresh',
  };
}

export async function runSignalMaturityWorker(): Promise<MaturityRunResult> {
  const t0 = Date.now();
  const result: MaturityRunResult = {
    scanned: 0, promoted: 0, matured: 0,
    developing: 0, candidate: 0, regime_blocked: 0,
    failed: 0, elapsedMs: 0,
  };

  let trackers: TrackerRow[];
  try {
    trackers = await getActiveTrackers();
  } catch (err: any) {
    console.warn('[signalMaturity] getActiveTrackers failed:', err?.message);
    result.elapsedMs = Date.now() - t0;
    return result;
  }
  result.scanned = trackers.length;

  // ── Step 10 — Data Quality Safety Gate (calibrated 2026-05) ──
  //
  // Spec INSTITUTIONAL §I — market-aware, fallback-tolerant DQ gate.
  //
  // Original behaviour: required a `q365_data_feed_health` row in the
  // last 10 minutes with status=success/partial; otherwise blocked
  // every promotion. After-hours and on quiet provider runs the table
  // had no recent rows → ageOk=false → ALL promotions silently blocked
  // → q365_confirmed_signal_snapshots stayed empty forever.
  //
  // New behaviour: the gate now uses a tiered quality probe and only
  // blocks when EVERY tier indicates degraded data:
  //
  //   1. q365_data_feed_health — primary signal. recentDq='LOW' is a
  //      hard veto (provider explicitly reported low-quality data).
  //   2. market_data_daily — if feed-health is empty/old, fall through
  //      to candle freshness. Bars within MATURITY_CANDLE_FRESH_MIN
  //      (default 6h when market open, 48h when closed) → DQ=OK.
  //   3. Open-by-default — if BOTH probes are empty, the gate ALLOWS
  //      promotion (the prior fail-closed behaviour permanently jammed
  //      promotion on fresh deploys / quiet periods, contrary to spec).
  //
  // Operator overrides:
  //   MATURITY_DQ_GATE=disabled        — bypass entirely (NOT recommended)
  //   MATURITY_DQ_FRESH_WINDOW_MIN=10  — feed-health window minutes
  //   MATURITY_CANDLE_FRESH_MIN=360    — open-market candle freshness cap
  //   MATURITY_CANDLE_FRESH_CLOSED_MIN=2880 — closed-market cap (48h)
  if (trackers.length > 0) {
    const dqDecision = await evaluateMaturityDqGate();
    // Spec INSTITUTIONAL §I — six structured log markers for the DQ +
    // freshness gate. Operators grep these to triage stuck promotions
    // without re-reading the worker source.
    console.log(
      `[DATA_QUALITY] feed_health=${dqDecision.feedHealthDq || 'NONE'} ` +
      `feed_health_age_min=${dqDecision.feedHealthAgeMin ?? 'n/a'} ` +
      `tier=${dqDecision.mode} verdict=${dqDecision.allowPromotion ? 'OK' : 'DEGRADED'}`,
    );
    console.log(
      `[CANDLE_AGE] latest_ts=${dqDecision.latestCandleTs ?? 'null'} ` +
      `age_minutes=${dqDecision.candleAgeMin ?? 'null'} ` +
      `limit_minutes=${dqDecision.candleFreshLimitMin} ` +
      `market_open=${dqDecision.marketOpen}`,
    );
    console.log(
      `[FRESHNESS_GATE] latest_candle_ts=${dqDecision.latestCandleTs ?? 'null'} ` +
      `candle_age_minutes=${dqDecision.candleAgeMin ?? 'null'} ` +
      `freshness_limit_minutes=${dqDecision.candleFreshLimitMin} ` +
      `ageOk=${dqDecision.candleAgeOk} ` +
      `recentDq=${dqDecision.feedHealthDq || 'NONE'} ` +
      `market_open=${dqDecision.marketOpen} ` +
      `dq_reason="${dqDecision.dqReason}" ` +
      `degraded_reason="${dqDecision.degradedReason ?? 'none'}"`,
    );
    console.log(
      `[MATURITY_FRESHNESS] mode=${dqDecision.mode} ` +
      `decision=${dqDecision.allowPromotion ? 'ALLOW' : 'BLOCK'} ` +
      `trackers=${trackers.length} reason="${dqDecision.reason}"`,
    );
    console.log(
      `[DQ_POLICY] mode=${dqDecision.mode} ` +
      `feed_health_dq=${dqDecision.feedHealthDq || 'NONE'} ` +
      `feed_health_age_min=${dqDecision.feedHealthAgeMin ?? 'n/a'} ` +
      `candle_age_min=${dqDecision.candleAgeMin ?? 'n/a'} ` +
      `candle_fresh_limit_min=${dqDecision.candleFreshLimitMin} ` +
      `market_open=${dqDecision.marketOpen} ` +
      `decision=${dqDecision.allowPromotion ? 'ALLOW' : 'BLOCK'} ` +
      `reason="${dqDecision.reason}"`,
    );
    if (!dqDecision.allowPromotion) {
      console.warn(
        `[PROMOTION_BLOCK] reason="${dqDecision.reason}" ` +
        `trackers=${trackers.length} ` +
        `to_unblock="${dqDecision.suggestion}"`,
      );
      result.elapsedMs = Date.now() - t0;
      return result;
    }
  }

  // MATURATION_AUDIT_2026-05 — clear the audit buffer at cycle start
  // so [MATURITY_BLOCKERS] reports only this cycle's data.
  _maturityAudit.length = 0;

  for (const t of trackers) {
    try {
      const outcome = await processTracker(t);
      if (outcome === 'promoted')             result.promoted++;
      else if (outcome === 'matured')         result.matured++;
      else if (outcome === 'developing')      result.developing++;
      else if (outcome === 'candidate')       result.candidate++;
      else if (outcome === 'regime_blocked')  result.regime_blocked++;
    } catch (err: any) {
      console.warn(`[signalMaturity] tracker ${t.id} (${t.symbol} ${t.direction}) failed:`, err?.message);
      result.failed++;
    }
  }

  result.elapsedMs = Date.now() - t0;
  // Spec INSTITUTIONAL §J — structured maturity-funnel summary. The
  // [PERSIST_SUCCESS] / [PERSIST_FAILED] lines emitted by
  // insertConfirmedSnapshotIfEligible give per-row visibility; this
  // line is the per-cycle aggregate for grepping "[MATURITY_FUNNEL]".
  if (trackers.length > 0) {
    console.log(
      `[MATURITY_FUNNEL] scanned=${result.scanned} ` +
      `promoted=${result.promoted} ` +
      `matured=${result.matured} ` +
      `developing=${result.developing} ` +
      `candidate=${result.candidate} ` +
      `regime_blocked=${result.regime_blocked} ` +
      `failed=${result.failed} ` +
      `elapsed_ms=${result.elapsedMs}`,
    );

    // MATURATION_AUDIT_2026-05 — distribution of trackers by cycle
    // count. The single most useful answer to "is the system stuck
    // at cycles=1 or accumulating?". A healthy distribution should
    // show counts spread across 1/2/3+ over time. If 100% of trackers
    // show cycles=1, the upsert is resetting every scan (likely the
    // stale-reset threshold). If counts cap at 2 and never reach 3,
    // scans are happening twice per stale-window then resetting.
    const cycleDist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4+': 0 };
    let maxCycles = 0;
    let avgAgeMin = 0;
    for (const a of _maturityAudit) {
      if (a.cycles >= 4)      cycleDist['4+']++;
      else if (a.cycles === 3) cycleDist['3']++;
      else if (a.cycles === 2) cycleDist['2']++;
      else                     cycleDist['1']++;
      if (a.cycles > maxCycles) maxCycles = a.cycles;
      avgAgeMin += a.age_min;
    }
    if (_maturityAudit.length > 0) {
      avgAgeMin = avgAgeMin / _maturityAudit.length;
    }
    console.log('[TRACKER_STATE_DISTRIBUTION]', {
      total_trackers:    _maturityAudit.length,
      cycle_distribution: cycleDist,
      max_cycles_observed: maxCycles,
      avg_age_min:       Math.round(avgAgeMin),
      stale_reset_threshold_min: Number(process.env.TRACKER_STALE_RESET_MIN ?? 360),
      diagnosis: (() => {
        if (_maturityAudit.length === 0) return 'no_trackers — pipeline produced no candidates this cycle';
        if (cycleDist['1'] === _maturityAudit.length) {
          return 'ALL trackers at cycles=1 — bug: cycles never accumulating. Check [CYCLE_ACCUMULATION] logs for reset_reason=stale frequency. If most resets are "stale", raise TRACKER_STALE_RESET_MIN. If saveSignals is not being called between scans, the upstream pipeline is the issue.';
        }
        if (cycleDist['3'] === 0 && cycleDist['4+'] === 0) {
          return 'cycles capped at 2 — scans happening twice per stale-window then resetting. Raise TRACKER_STALE_RESET_MIN.';
        }
        return 'distribution looks healthy — trackers accumulating cycles correctly';
      })(),
    });

    // MATURATION_AUDIT_2026-05 — top-30 strongest non-promoted rows
    // + cause histogram. The single most useful signal for "why is
    // APPROVED empty?" when the funnel above shows promoted=0.
    if (result.promoted < trackers.length && _maturityAudit.length > 0) {
      const nonPromoted = _maturityAudit.filter((a) => a.stage !== 'mature' || a.score < STAGE_MATURE_THRESHOLD_FOR_AUDIT);
      // Cause histogram — bucket by the row's primary blocker.
      const causes: Record<string, number> = {};
      for (const a of _maturityAudit) {
        // Skip rows that DID promote (their blocker is irrelevant).
        if (a.stage === 'mature' && a.score >= STAGE_MATURE_THRESHOLD_FOR_AUDIT && a.stable) continue;
        const key = (() => {
          if (!a.stable && a.stability_raw < 0.55)              return 'stability_drift';
          if (a.cycles < 3)                                     return 'insufficient_cycles';
          if (a.age_min < 10)                                   return 'insufficient_age';
          if (a.score < STAGE_MATURE_THRESHOLD_FOR_AUDIT)       return 'score_below_mature';
          if (a.blocker === 'final_score trending down across cycles') return 'trend_down';
          if (a.blocker?.includes('regime'))                    return 'regime_alignment';
          if (a.blocker?.includes('decay'))                     return 'decay_risk';
          if (a.blocker?.includes('false-signal'))              return 'false_signal_probability';
          if (a.blocker?.includes('factor confluence'))         return 'multi_factor_low';
          return a.blocker || 'unknown';
        })();
        causes[key] = (causes[key] ?? 0) + 1;
      }
      const ranked = Object.entries(causes).sort((a, b) => b[1] - a[1]);
      const dominant = ranked[0]?.[0] ?? 'none';
      const dominantCount = ranked[0]?.[1] ?? 0;
      const top30 = [..._maturityAudit]
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
      console.log('[MATURITY_BLOCKERS]', {
        total_trackers:    _maturityAudit.length,
        promoted:          result.promoted,
        non_promoted:      nonPromoted.length,
        dominant_cause:    dominant,
        dominant_count:    dominantCount,
        cause_histogram:   ranked.slice(0, 8),
        floors_active: {
          mature_threshold:           STAGE_MATURE_THRESHOLD_FOR_AUDIT,
          stability_raw_floor:        Number(process.env.MATURITY_STABILITY_RAW_FLOOR ?? 0.55),
          conf_drift_tolerance:       Number(process.env.MATURITY_CONF_DRIFT_TOLERANCE ?? 15),
          price_drift_tolerance_pct:  Number(process.env.MATURITY_PRICE_DRIFT_TOLERANCE ?? 0.025) * 100,
          min_cycles:                 Number(process.env.MATURITY_MIN_CYCLES ?? 3),
          min_age_min:                Number(process.env.MATURITY_MIN_AGE_MINUTES ?? 10),
        },
        suggested_env: (() => {
          if (dominant === 'stability_drift')        return 'MATURITY_CONF_DRIFT_TOLERANCE=20 (currently 15) or MATURITY_STABILITY_RAW_FLOOR=0.45 (currently 0.55) — let mostly-stable plans graduate';
          if (dominant === 'insufficient_cycles')    return 'wait — trackers need MATURITY_MIN_CYCLES (3) cycles before graduating; this clears naturally as the cron runs';
          if (dominant === 'insufficient_age')       return 'wait — MATURITY_MIN_AGE_MINUTES (10) seasoning floor; this clears naturally';
          if (dominant === 'score_below_mature')     return 'MATURITY_MATURE_THRESHOLD=70 (currently 75) — let strong-but-not-perfect rows graduate';
          if (dominant === 'trend_down')             return 'final_score is decaying across cycles — check Phase 4 reranker';
          if (dominant === 'regime_alignment')       return 'engine output fights the regime — inspect market_regime classifier';
          if (dominant === 'decay_risk')             return 'rows aging past freshness — increase candle/freshness window';
          return `inspect [PROMOTION_SCORE] entries with blocker="${dominant}"`;
        })(),
        top_30_by_score: top30.map((a) => ({
          symbol:         `${a.symbol}/${a.direction}`,
          score:          a.score,
          stage:          a.stage,
          cycles:         a.cycles,
          age_min:        a.age_min,
          confidence:     a.confidence,
          rr:             a.rr,
          stability_raw:  a.stability_raw,
          stable:         a.stable,
          conviction:     a.conviction,
          classification: a.classification,
          blocker:        a.blocker,
        })),
      });
    }
  }
  return result;
}
