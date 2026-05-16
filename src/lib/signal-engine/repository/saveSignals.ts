// ════════════════════════════════════════════════════════════════
//  Signal Persistence — MySQL
// ════════════════════════════════════════════════════════════════

// MATURATION_AUDIT_2026-05 — module-load version stamp. Operator
// reported tracker-bump logs were missing entirely; the version
// stamp confirms whether the runtime actually loaded THIS file
// (vs serving a stale .next build artifact). If you don't see this
// line in the log on server start, the dev server hasn't picked
// up the new code and you need to clear .next + restart.
console.log('[SAVE_SIGNALS_VERSION] build=cycle_fix_v3 file=src/lib/signal-engine/repository/saveSignals.ts loaded_at=' + new Date().toISOString());

import { db } from '@/lib/db';
import type { QuantSignal, StrategyName } from '../types/signalEngine.types';
import { makeProvenance, type EngineProvenance } from '../constants/engineVersion';
import { getSector, deriveVolatilityState } from '../constants/phase3.constants';
import { resolvePrice } from '@/lib/marketData/resolver/marketDataResolver';
import { computeFreshnessReport } from '../freshness/freshnessEngine';
import { validatePostSignal } from '../validation/postSignalValidator';
import { computeFinalScore } from '../ranking/dynamicRanker';
import { upsertTrackerOnDetection } from './maturityTracker';

// Maximum acceptable gap between the strategy-derived entry price
// (built from daily candles, possibly hours stale) and the live
// LTP at signal-write time. Any signal whose entry zone is more than
// this fraction away from the live tape is rejected as untradeable —
// the trade plan would otherwise tell a trader to enter at a price
// the market has already moved past.
//
// Default raised 5% → 10% because a hardcoded 5% wiped out entire
// batches after weekend gaps / opening volatility. The post-LTP
// reanchor below preserves the ORIGINAL risk and reward distances
// regardless of gap size, so a wider tolerance here doesn't make
// the trade plan any worse — it just lets the row reach the DB.
// Override with SAVE_SIGNAL_MAX_ENTRY_GAP_PCT (decimal, e.g. 0.15 for 15%).
const MAX_ENTRY_GAP_PCT = (() => {
  const raw = Number(process.env.SAVE_SIGNAL_MAX_ENTRY_GAP_PCT);
  if (Number.isFinite(raw) && raw > 0 && raw <= 1) return raw;
  return 0.10; // 10%
})();

// Coerce any ISO-8601 string (or Date) to MySQL DATETIME format.
// MySQL strict mode rejects values with a trailing 'Z' (error 1292
// Incorrect datetime value). Use this for every DATETIME column
// write in this file. Returns null for null/empty so optional
// columns stay nullable.
function toMysqlDateTime(input: string | Date | null | undefined): string | null {
  if (input == null || input === '') return null;
  const iso = input instanceof Date ? input.toISOString() : String(input);
  // Already in MySQL format? leave it
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) return iso;
  // ISO 8601 → MySQL: drop fractional seconds + Z, swap T for space
  return iso.slice(0, 19).replace('T', ' ');
}

// Hard floor — set to 0 so saveSignals no longer drops rows on
// confidence alone. Quality filtering happens at API output time
// via FINAL_CONFIDENCE_FLOOR, which keeps the full distribution in
// the DB and lets the read path apply (or skip) the cut. The user
// explicitly wants every scored signal persisted so the top 50 by
// confidence is always available regardless of how strict the
// stance/scoring engines were on a given day.
const MIN_CONFIDENCE_FLOOR = 0;

// Direction-vs-momentum guards. Block obvious contradictions between
// the strategy's stated direction and the live intraday move:
//   - BUY into a strong sell-off (>3% down today) is rejected
//   - SELL into a strong rally  (>3% up   today) is rejected
// 3% is a deliberate buffer — most pullback/mean-reversion strategies
// trigger inside ±2%, only outright contradictions get blocked.
const BUY_MAX_DOWN_PCT  = -3;
const SELL_MAX_UP_PCT   =  3;

// ── Legacy-UI compatibility mapping ──────────────────────────
// The signals/intelligence pages read columns the new engine didn't
// originally populate. We fill them here so existing GET readers
// (services/signalPipeline.ts → getActiveSignals / getIntelligenceSignals)
// can surface new-engine rows without a reader rewrite. This is the
// Phase 1 adapter-cutover approach — writer side moves to the new engine,
// reader side stays, and these columns bridge the gap.

const STRATEGY_TO_SCENARIO: Record<StrategyName, string> = {
  bullish_breakout:       'BREAKOUT_CONTINUATION',
  bullish_pullback:       'PULLBACK_IN_TREND',
  bearish_breakdown:      'BREAKOUT_CONTINUATION',
  mean_reversion_bounce:  'MEAN_REVERSION',
  momentum_continuation:  'MOMENTUM_EXPANSION',
  bullish_divergence:     'MEAN_REVERSION',
  volume_climax_reversal: 'MEAN_REVERSION',
  gap_continuation:       'EVENT_DRIVEN',
  range_breakout:         'BREAKOUT_CONTINUATION',
  ema_crossover:          'MOMENTUM_EXPANSION',
  oversold_bounce:        'MEAN_REVERSION',
  overbought_reversal:    'MEAN_REVERSION',        // mirror of oversold_bounce
  weak_trend_breakdown:   'BREAKOUT_CONTINUATION', // breakdown family (mirror of bearish_breakdown)
};

function deriveMarketStance(regime: string): string {
  const r = (regime || '').toUpperCase();
  if (r.includes('STRONG_BULL')) return 'aggressive';
  if (r.includes('BULL') || r === 'BULLISH') return 'selective';
  if (r.includes('STRONG_BEAR')) return 'capital_preservation';
  if (r.includes('BEAR') || r === 'BEARISH') return 'defensive';
  return 'selective';
}

// deriveVolatilityState is imported from constants/phase3.constants so
// the live signal writer and the backtest signal writer produce
// identical bucket labels for the same atrPct input.

/**
 * Save signals and return map of symbol → inserted DB ID.
 * This enables downstream saves (breakdowns, explanations) to reference real IDs.
 *
 * `generationSource` is persisted to q365_signals.generation_source so we can
 * attribute each row to its entry point (API action, backtest run, adapter, etc).
 */
type SaveOutcome =
  | { kind: 'saved'; id: number }
  | { kind: 'rejected'; reason: 'live_gap' | 'low_confidence' | 'momentum_contradiction' | 'duplicate_in_batch' | 'duplicate_in_db' | 'no_direction' };

export async function saveSignals(
  signals: QuantSignal[],
  generationSource: string = 'signal-engine:unknown',
): Promise<Map<string, number>> {
  const idMap = new Map<string, number>();
  if (signals.length === 0) return idMap;

  const provenance = makeProvenance(generationSource);

  // Expire old active/watchlist signals keyed by (symbol, direction).
  // Historical behaviour: expire-by-symbol dropped the secondary
  // direction when a symbol had both a BUY and a SELL (e.g. RELIANCE
  // with a bullish trend + a weak_trend_breakdown SELL). After the
  // Nov 2026 best-per-direction fix, Phase 3 can emit both directions
  // for the same symbol — expiring + replacing them must be keyed by
  // BOTH fields so one BUY + one SELL can coexist in the 'active' set.
  //
  // We run one UPDATE per (symbol, direction) pair — cheap even for
  // 100 symbols × 2 directions = 200 statements, since each is an
  // indexed-equality UPDATE. MySQL lets us batch these in one call
  // via a CASE/OR expression, but the simpler shape below is easier
  // to read and still O(N) round trips where N ≤ 200.
  const pairs = new Set<string>();
  for (const s of signals) {
    const dir = s.action === 'enter_short' ? 'SELL' : 'BUY';
    pairs.add(`${s.symbol}:${dir}`);
  }
  if (pairs.size > 0) {
    const expireClauses: string[] = [];
    const expireParams: string[] = [];
    for (const pair of pairs) {
      const [sym, dir] = pair.split(':');
      expireClauses.push('(symbol = ? AND direction = ?)');
      expireParams.push(sym, dir);
    }
    // Include 'stale' so a (symbol, direction) row that's currently
    // sticky-visible (kept around for SIGNAL_STICKY_VISIBILITY_MIN by
    // the route's cross-batch sweep) is also expired when a fresh
    // signal for the same pair is being inserted in this batch. Without
    // this, the new ACTIVE row would coexist with the leftover STALE
    // row and the dashboard would render the same setup twice.
    await db.query(
      `UPDATE q365_signals SET status = 'expired'
       WHERE (${expireClauses.join(' OR ')})
         AND status IN ('active', 'watchlist', 'stale')`,
      expireParams,
    );
  }

  // seenInBatch key = "symbol:direction" so one BUY + one SELL per
  // symbol can both proceed. Prior bug: keying by symbol alone
  // silently dropped the second direction emitted by Phase 3.
  const seenInBatch = new Set<string>();
  const tally: Record<string, number> = {
    saved: 0, live_gap: 0, low_confidence: 0,
    momentum_contradiction: 0, duplicate_in_batch: 0,
    duplicate_in_db: 0, no_direction: 0,
  };

  for (const signal of signals) {
    try {
      const dirKey = signal.action === 'enter_short' ? 'SELL' : 'BUY';
      const symKey = `${signal.symbol.toUpperCase()}:${dirKey}`;
      if (seenInBatch.has(symKey)) {
        tally.duplicate_in_batch++;
        console.warn(`[saveSignals] DEDUPE ${symKey} — already processed in this batch`);
        continue;
      }
      seenInBatch.add(symKey);

      const outcome = await saveOneSignal(signal, provenance);
      if (outcome.kind === 'saved') {
        idMap.set(signal.symbol, outcome.id);
        tally.saved++;
      } else {
        tally[outcome.reason]++;
      }
    } catch (err) {
      console.error(`[SignalEngine] Failed to save signal for ${signal.symbol}:`, err);
    }
  }

  console.log(
    `[saveSignals] batch summary  in=${signals.length}  saved=${tally.saved}  ` +
    `live_gap=${tally.live_gap}  low_conf=${tally.low_confidence}  ` +
    `momentum=${tally.momentum_contradiction}  dup_batch=${tally.duplicate_in_batch}  ` +
    `dup_db=${tally.duplicate_in_db}  no_dir=${tally.no_direction}`
  );
  // Spec "FIX ZERO SIGNALS" §1 + §5 — explicit [DB] line so operators
  // grepping for "[DB]" can see at a glance whether q365_signals
  // actually got rows. Grouped by signal_status so the relaxed-tier
  // fallback's expected source (DEVELOPING_SETUP) is visible too.
  const sourceTag = generationSource ?? 'unknown';
  console.log(
    `[DB] q365_signals INSERT  source=${sourceTag}  inserted=${tally.saved}/${signals.length}  ` +
    `rejected=${tally.live_gap + tally.low_confidence + tally.momentum_contradiction + tally.no_direction}  ` +
    `dedup=${tally.duplicate_in_batch + tally.duplicate_in_db}`,
  );
  console.log(
    `[DB INSERT] table=q365_signals count=${tally.saved} source=${sourceTag} attempted=${signals.length}`,
  );
  // Spec INSTITUTIONAL §J — single greppable persistence-funnel line.
  // Emitted once per saveSignals call. The maturity worker is the
  // separate path that writes q365_confirmed_signal_snapshots; this
  // line covers ONLY the scanner→q365_signals leg.
  console.log(
    `[PERSIST_FUNNEL] table=q365_signals source=${sourceTag} ` +
    `attempted=${signals.length} persisted=${tally.saved} ` +
    `rejected_before_save=${tally.live_gap + tally.low_confidence + tally.momentum_contradiction + tally.no_direction} ` +
    `deduped=${tally.duplicate_in_batch + tally.duplicate_in_db}`,
  );
  if (tally.saved === 0 && signals.length > 0) {
    console.warn(
      `[DB] q365_signals INSERT produced 0 rows from ${signals.length} candidates ` +
      `— check the per-reason tally above. Live-gap / low-conf / momentum rejects ` +
      `are silent gates inside saveOneSignal; lower them via env if intended.`,
    );
  }
  return idMap;
}

async function saveOneSignal(s: QuantSignal, provenance: EngineProvenance): Promise<SaveOutcome> {
  // MATURATION_AUDIT_2026-05 — entry trace. Fires on EVERY call so
  // an operator can prove (a) the function is being invoked and (b)
  // for which symbols. If this log is missing for a symbol that has
  // an active q365_signals row, Phase 4 is upstream-filtering it.
  console.log(
    `[SAVE_ONE_SIGNAL_ENTER] symbol=${s.symbol} ` +
    `action=${s.action ?? 'null'} ` +
    `confidence=${s.confidenceScore ?? 'null'} ` +
    `runtime_ts=${new Date().toISOString()}`,
  );
  // ── Gate A: direction must be unambiguous ───────────────
  // SignalAction is a union of enter_on_strength | enter_on_pullback |
  // enter_short | enter_on_bounce | enter_on_momentum | enter_on_divergence |
  // enter_on_climax | enter_on_gap. Anything that isn't 'enter_short' is a
  // long entry. Reject only when action is missing outright.
  if (!s.action) {
    console.warn(`[saveSignals] REJECT ${s.symbol} — missing action`);
    return { kind: 'rejected', reason: 'no_direction' };
  }
  const direction: 'BUY' | 'SELL' = s.action === 'enter_short' ? 'SELL' : 'BUY';

  // ── Gate B: hard confidence floor ───────────────────────
  // Defensive — upstream stance gating may have lowered the threshold
  // below what we consider tradeable. Block here regardless.
  if ((s.confidenceScore ?? 0) < MIN_CONFIDENCE_FLOOR) {
    console.warn(
      `[saveSignals] REJECT ${s.symbol} ${direction} — confidence ${s.confidenceScore} ` +
      `< floor ${MIN_CONFIDENCE_FLOOR}`
    );
    return { kind: 'rejected', reason: 'low_confidence' };
  }

  // ── Gate C: defensive DB dedupe (symbol + direction) ────
  // Keyed by BOTH fields so one BUY + one SELL for the same symbol
  // can coexist. Previously symbol-only, which silently rejected
  // the second direction if Phase 3 emitted both.
  //
  // MATURATION_AUDIT_2026-05 — CRITICAL FIX. The dedupe was returning
  // early BEFORE reaching upsertTrackerOnDetection at the bottom of
  // this function, which meant trackers never accumulated cycles past
  // 1: scan #1 inserted the signal + tracker, scan #2+ saw the dupe
  // and bailed without bumping the tracker. The maturity worker
  // therefore saw `cycles=1, age_min=1972` (33h-old trackers stuck at
  // their initial cycle). Operator confirmed: "[CYCLE_ACCUMULATION]
  // logs are NOT appearing" — because the function exited 350 lines
  // before reaching the tracker call.
  //
  // Fix: when we detect the duplicate, STILL call upsertTrackerOnDetection
  // with the existing q365_signals row's id so the tracker increments.
  // Then return rejected (the q365_signals INSERT is correctly
  // suppressed; only the tracker bookkeeping path is taken).
  try {
    const dup = await db.query(
      `SELECT id, entry_price, stop_loss, target1, confidence_score, final_score, decay_state
         FROM q365_signals
        WHERE symbol = ? AND direction = ? AND status IN ('active','watchlist')
        LIMIT 1`,
      [s.symbol, direction],
    );
    const existingRow = ((dup.rows as any[]) ?? [])[0];
    if (existingRow) {
      console.log(`[PIPELINE_TRACE] stage=dedupe_branch symbol=${s.symbol} direction=${direction} existing_id=${existingRow.id}`);
      console.log(`[DEDUPE_BRANCH_HIT] symbol=${s.symbol} direction=${direction} existing_id=${existingRow.id}`);
      console.warn(`[saveSignals] DEDUPE ${s.symbol}:${direction} — active row already exists in DB (id=${existingRow.id}); bumping tracker without re-inserting`);
      // Bump the tracker so cycles accumulate across re-detections.
      // The maturity worker reads from q365_signal_maturity_tracker
      // independently — without this call, the tracker would never
      // see a re-detection event and cycles would stay at 1 forever.
      console.log(`[PIPELINE_TRACE] stage=tracker_update symbol=${s.symbol} direction=${direction}`);
      console.log(`[TRACKER_BUMP_CALL] symbol=${s.symbol} direction=${direction} signal_id=${existingRow.id}`);
      try {
        const trackerResult = await upsertTrackerOnDetection({
          symbol:      s.symbol,
          direction,
          signal_id:   Number(existingRow.id),
          entry_price: Number(existingRow.entry_price),
          stop_loss:   Number(existingRow.stop_loss),
          target1:     Number(existingRow.target1),
          confidence:  Number(s.confidenceScore ?? existingRow.confidence_score ?? 0),
          final_score: existingRow.final_score != null ? Number(existingRow.final_score) : null,
          decay_state: existingRow.decay_state ?? null,
        });
        console.log(
          `[PIPELINE_TRACE] stage=cycle_increment symbol=${s.symbol} ` +
          `direction=${direction} cycles=${trackerResult.cycles} ` +
          `stage=${trackerResult.stage} reset=${trackerResult.reset} ` +
          `reason=${trackerResult.resetReason}`,
        );
        if (trackerResult.cycles > 1) {
          console.log(
            `[saveSignals] tracker bump-via-dedupe ${s.symbol} ${direction} ` +
            `cycle=${trackerResult.cycles} stage=${trackerResult.stage}`,
          );
        }
      } catch (err: any) {
        console.warn(
          `[saveSignals] tracker bump-via-dedupe failed for ${s.symbol} ${direction}: ${err?.message}`,
        );
      }
      return { kind: 'rejected', reason: 'duplicate_in_db' };
    }
  } catch { /* table-level dedupe is best-effort; fall through */ }

  const strategyEntry = s.entry.zoneHigh; // conservative entry price from candle-based strategy
  const strategyStop  = s.stopLoss;
  const strategyT1    = s.targets.target1;
  const strategyT2    = s.targets.target2;

  // ── Live-price reconciliation ────────────────────────────
  // The strategy computes entry/stop/target from daily candles, which
  // can be hours stale by the time saveOneSignal runs. Resolve the
  // live LTP through MarketDataResolver (Kite primary, Yahoo fallback),
  // validate the entry isn't drifted beyond MAX_ENTRY_GAP_PCT, and
  // recalculate stop/target so they remain anchored to the live tape
  // with the original risk distance and reward distance preserved.
  // Original R:R is therefore preserved exactly.
  let entryPrice = strategyEntry;
  let stopLoss   = strategyStop;
  let target1    = strategyT1;
  let target2    = strategyT2;
  let livePctChange: number | null = null;

  let momentumViolation = false;

  try {
    const quote = await resolvePrice(s.symbol);
    if (quote.price != null && quote.price > 0) {
      const ltp = quote.price;
      const gap = Math.abs(strategyEntry - ltp) / ltp;

      if (gap > MAX_ENTRY_GAP_PCT) {
        console.warn(
          `[saveSignals] REJECT ${s.symbol} ${direction} — entry ${strategyEntry} is ` +
          `${(gap * 100).toFixed(2)}% from LTP ${ltp} (max ${MAX_ENTRY_GAP_PCT * 100}%) — untradeable, skipping insert`
        );
        return { kind: 'rejected', reason: 'live_gap' };
      }

      // ── Gate D: trend / momentum direction validation ──
      // Block obvious contradictions between stated direction and
      // intraday move. A BUY into a -3% sell-off is fighting the
      // tape; a SELL into a +3% rally is doing the same in reverse.
      const pct = Number(quote.pChange ?? 0);
      if (direction === 'BUY' && pct < BUY_MAX_DOWN_PCT) {
        console.warn(
          `[saveSignals] REJECT ${s.symbol} BUY — intraday ${pct.toFixed(2)}% ` +
          `below floor ${BUY_MAX_DOWN_PCT}% (price falling, momentum contradicts)`
        );
        momentumViolation = true;
      } else if (direction === 'SELL' && pct > SELL_MAX_UP_PCT) {
        console.warn(
          `[saveSignals] REJECT ${s.symbol} SELL — intraday +${pct.toFixed(2)}% ` +
          `above ceiling +${SELL_MAX_UP_PCT}% (price rising, momentum contradicts)`
        );
        momentumViolation = true;
      }
      if (momentumViolation) {
        return { kind: 'rejected', reason: 'momentum_contradiction' };
      }

      // Preserve the strategy's risk and reward distances, but anchor
      // them to the live tape so the trade plan reflects what a trader
      // would actually see right now.
      const riskDist   = strategyEntry - strategyStop;        // signed: + for BUY, − for SELL
      const rewardDist = strategyT1   - strategyEntry;         // signed: + for BUY, − for SELL
      const reward2Dist = strategyT2 != null ? (strategyT2 - strategyEntry) : null;

      entryPrice = ltp;
      stopLoss   = ltp - riskDist;
      target1    = ltp + rewardDist;
      target2    = reward2Dist != null ? ltp + reward2Dist : null;
      livePctChange = quote.pChange ?? null;

      console.log(
        `[saveSignals] ${s.symbol} ${direction} entry ${strategyEntry}→${ltp.toFixed(2)} ` +
        `(gap ${(gap * 100).toFixed(2)}%)  stop=${stopLoss.toFixed(2)}  t1=${target1.toFixed(2)}  src=${quote.source}`
      );
    } else {
      console.warn(`[saveSignals] ${s.symbol} — resolver returned no live price, persisting strategy values as fallback`);
    }
  } catch (err: any) {
    console.warn(`[saveSignals] ${s.symbol} — live-price resolve failed (${err?.message}), persisting strategy values as fallback`);
  }

  const riskReward = Math.round(s.rewardRiskApprox * 10) / 10;

  // Legacy-UI compat columns: derive from typed fields so GET readers
  // in services/signalPipeline.ts see a row they can render.
  // opportunity_score: the legacy ORDER BY key — use confidenceScore
  // as a proxy (higher confidence sorts first, matching user intent).
  const opportunityScore = s.confidenceScore;
  const scenarioTag = STRATEGY_TO_SCENARIO[s.signalType as StrategyName] ?? 'NO_STRATEGY';
  const marketStance = deriveMarketStance(s.marketRegime);
  const factorScoresJson = s.confidenceBreakdown
    ? JSON.stringify(s.confidenceBreakdown, (_k, v) =>
        typeof v === 'number' && !isFinite(v) ? null : v)
    : null;

  // Enrichment columns — fill the gaps the feedback evaluator and
  // backtest analytics were working around with 'unknown'/null.
  // Sector comes from the static symbol → sector map in
  // phase3.constants (same source the correlation and portfolio-fit
  // engines use, so all three now agree). Volatility state buckets
  // the realized ATR% at signal time into a regime label.
  const sector = getSector(s.symbol);
  const volatilityState = deriveVolatilityState(s.features?.volatility?.atrPct);

  // Legacy-UI columns that the reader (readSignals.getActiveSignals)
  // selects but the old INSERT never populated — every row was showing
  // null/0 for these in the UI. Phase 3 back-fills portfolio_fit_score
  // after savePhase3Artifacts runs; we write a placeholder here so the
  // column is non-null on initial insert.
  const portfolioFitScore = 0; // placeholder — Phase 3 UPDATEs after save
  const regimeAlignment = (() => {
    const r = (s.marketRegime || '').toUpperCase();
    if (r.includes('STRONG_BULL')) return 95;
    if (r.includes('BULL')) return 80;
    if (r.includes('STRONG_BEAR')) return 20;
    if (r.includes('BEAR')) return 35;
    return 65; // NEUTRAL
  })();
  const ltpValue = entryPrice; // entryPrice is now live LTP (or strategy fallback)

  // ── Phase 4 dynamic ranking: seed final_score at birth ─────
  // We run the same freshness → validator → ranker chain the
  // 5-minute cron runs, but with generatedAt = now and current
  // price = entry. That produces freshnessScore = 100, decay =
  // 'fresh', overextension = 0, verdict = 'keep'. The resulting
  // finalScore is the "full value" of the signal — any later
  // rescore can only reduce it. This means the initial rank
  // is consistent with future reranks (no score jump at tick 1).
  const nowIso = new Date().toISOString();
  const seedFreshness = computeFreshnessReport({
    generatedAt:  nowIso,
    direction,
    entryPrice,
    stopLoss,
    target1,
    currentPrice: entryPrice,
    barsElapsed:  0,
  });
  const seedVerdict = validatePostSignal({
    direction, entryPrice, stopLoss, target1,
    currentPrice: entryPrice,
    freshness: seedFreshness,
  });
  const seedRank = computeFinalScore({
    confidenceScore:     s.confidenceScore,
    regimeAlignment:     regimeAlignment,
    portfolioFit:        portfolioFitScore,
    marketStance:        marketStance,
    direction,
    eventRiskScore:      null, // news enrichment happens downstream in Phase 4
    manipulationPenalty: null, // manipulation join applied at rescore time
    freshness:           seedFreshness,
    verdict:             seedVerdict,
  });

  // Time-based expiry cap — if no rescore ever runs, signals
  // still auto-expire after 3 trading days so the dashboard
  // can't show week-old rows when the cron is down.
  const expiresAt = toMysqlDateTime(
    new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  );

  // Product-facing tri-state classification, persisted alongside
  // the lifecycle `status` column. saveSignals only ever receives
  // signals the rejection engine did NOT reject outright — so the
  // classification is entirely driven by `status` and confidence:
  //   - status='active' + conf ≥ 55 → APPROVED_SIGNAL
  //   - status='watchlist'           → DEVELOPING_SETUP
  //   - active but below conv floor → DEVELOPING_SETUP
  // NO_TRADE never reaches this writer (those rows are filtered
  // upstream in generatePhase3Signals). readSignals derives the
  // same tri-state on the fly for historical rows whose column is
  // still NULL.
  const sigStatus: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' =
    s.status === 'watchlist'             ? 'DEVELOPING_SETUP'
    : (s.confidenceScore ?? 0) < 55      ? 'DEVELOPING_SETUP'
    :                                      'APPROVED_SIGNAL';

  // ── Phase-4 scoring values (calculateFinalScore + 6-band) ─────
  // Threaded from ExecutableSignal via generatePhase4Signals. When
  // absent (legacy callers, pre-Phase-4 backfill), the new columns
  // stay NULL and the read path falls back to the dynamic ranker's
  // `final_score` for filtering/ordering. Existing `final_score`
  // (dynamic) and the new `composite_final_score` (Phase-2) are
  // both written so the Phase-1 hard gate remains untouched.
  const phase4FinalScore     = s.phase4FinalScore     ?? null;
  const phase4Classification = s.phase4Classification ?? null;
  const phase4FactorScoresJson = s.phase4FactorScores
    ? JSON.stringify(s.phase4FactorScores)
    : null;

  // ── Phase-11 unified row block ────────────────────────────────
  // Threaded from runPhase11Pipeline via generatePhase4Signals.
  // Every field stays null/empty when the upstream pipeline didn't
  // run (legacy callers, backfill scripts) — the read path tolerates
  // those nulls, and the Phase-12 partition treats them as "field
  // not yet populated → pass" so existing rows keep flowing.
  const stressSurvivalScore = s.phase11StressSurvivalScore ?? null;
  const liveValidValue =
    s.phase11LiveValid === true  ? 1 :
    s.phase11LiveValid === false ? 0 :
    null;
  const recommendedQuantity = s.phase11RecommendedQuantity ?? null;
  const recommendedCapital  = s.phase11RecommendedCapital  ?? null;
  const rejectionCodesJson =
    s.phase11RejectionCodes && s.phase11RejectionCodes.length > 0
      ? JSON.stringify(s.phase11RejectionCodes)
      : null;
  const rejectionReasonsJson =
    s.phase11RejectionReasons && s.phase11RejectionReasons.length > 0
      ? JSON.stringify(s.phase11RejectionReasons)
      : null;
  const liveValidationReasonsJson =
    s.phase11LiveValidationReasons && s.phase11LiveValidationReasons.length > 0
      ? JSON.stringify(s.phase11LiveValidationReasons)
      : null;
  const explanationJson = s.phase11Explanation
    ? JSON.stringify(s.phase11Explanation)
    : null;

  const result: any = await db.query(
    `INSERT INTO q365_signals
      (symbol, instrument_key, exchange, direction, timeframe, signal_type,
       confidence_score, confidence_band, risk_score, risk_band,
       entry_price, stop_loss, target1, target2, risk_reward,
       market_regime, status, signal_status, generated_at,
       opportunity_score, scenario_tag, market_stance, factor_scores_json,
       sector, volatility_state,
       portfolio_fit_score, regime_alignment, ltp, pct_change, batch_id,
       engine_phase, engine_version, generation_source, code_build,
       final_score, freshness_score, decay_state, age_bars,
       overextension_pct, last_rescored_at, expires_at,
       composite_final_score, classification, phase4_factor_scores_json,
       stress_survival_score, recommended_quantity, recommended_capital,
       live_valid, rejection_codes_json, rejection_reasons_json,
       live_validation_reasons_json, explanation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.symbol, `NSE_EQ|${s.symbol}`, 'NSE', direction,
      s.timeframe, s.signalType,
      s.confidenceScore, s.confidenceBand,
      s.riskScore, s.riskBand,
      entryPrice, stopLoss, target1, target2,
      riskReward, s.marketRegime,
      s.status === 'active' ? 'active' : s.status === 'watchlist' ? 'watchlist' : 'active',
      sigStatus,
      toMysqlDateTime(s.generatedAt),
      opportunityScore, scenarioTag, marketStance, factorScoresJson,
      sector, volatilityState,
      // Spec "FIX BATCH_ID PERSISTENCE BUG" — column 30 is `batch_id`,
      // NOT generation_source. The previous value here was
      // `provenance.generation_source` (e.g. 'api:run-signal-engine:adapter'),
      // which silently overrode the per-run batch id. Two compounding
      // failures resulted:
      //   1. The route's UPDATE-batch-id step (`WHERE batch_id IS NULL`)
      //      never matched, so the proper `batch_1234567890` id was
      //      never stamped.
      //   2. The route's expire-old-batches step
      //      (`WHERE batch_id <> ${this_run_id}`) then matched EVERY
      //      newly-inserted row (because they all carried the literal
      //      string 'api:run-signal-engine:adapter') and set
      //      status='expired', wiping every fresh signal immediately.
      // Setting `batch_id = null` here lets the route's two UPDATE
      // queries do their job: the first stamps the real batch id,
      // the second only expires actually-stale rows from prior runs.
      // For auto-recovery (which doesn't run those UPDATEs), batch_id
      // stays null and the freshness probe + expire logic skip the row
      // gracefully — that's the documented null-batch behavior.
      portfolioFitScore, regimeAlignment, ltpValue, livePctChange, null /* batch_id */,
      provenance.engine_phase, provenance.engine_version,
      provenance.generation_source, provenance.code_build,
      seedRank.finalScore, seedFreshness.freshnessScore, seedFreshness.decayState, seedFreshness.ageBars,
      seedFreshness.overextensionPct, toMysqlDateTime(nowIso), expiresAt,
      phase4FinalScore, phase4Classification, phase4FactorScoresJson,
      stressSurvivalScore, recommendedQuantity, recommendedCapital,
      liveValidValue, rejectionCodesJson, rejectionReasonsJson,
      liveValidationReasonsJson, explanationJson,
    ],
  );

  // db.query now exposes insertId directly for INSERT statements
  const signalId = result.insertId;
  if (!signalId) {
    console.warn(`[saveSignals] ${s.symbol} INSERT returned no id`);
    return { kind: 'rejected', reason: 'no_direction' };
  }

  // 2. Batch insert reasons and warnings
  const allReasons = [
    ...s.reasons.map((msg) => [signalId, 'reason', msg]),
    ...s.warnings.map((msg) => [signalId, 'warning', msg]),
  ];
  if (allReasons.length > 0) {
    const valuesPlaceholder = allReasons.map(() => '(?, ?, ?)').join(', ');
    await db.query(
      `INSERT INTO q365_signal_reasons (signal_id, reason_type, message) VALUES ${valuesPlaceholder}`,
      allReasons.flat(),
    );
  }

  // 3. Insert feature snapshot (safely serialize, replacing NaN with null)
  const featuresJson = s.features
    ? JSON.stringify(s.features, (_key, value) =>
        typeof value === 'number' && !isFinite(value) ? null : value)
    : null;
  if (featuresJson) {
    await db.query(
      `INSERT INTO q365_signal_feature_snapshots (signal_id, features_json) VALUES (?, ?)`,
      [signalId, featuresJson],
    );
  }

  // 4. Seed lifecycle history with the canonical 'generated' state.
  //
  // This guarantees the invariant "every signal has at least one
  // lifecycle row, and the first row is 'generated'". Downstream
  // writers (savePhase3Artifacts, transitionSignalLifecycle, the
  // POST /api/signals/:id/lifecycle endpoint) append more rows —
  // they never overwrite this one. The lifecycle table is append-
  // only by design (INSERT, not UPSERT).
  //
  // Silent catch: if the lifecycle table doesn't exist yet (legacy
  // DB boot), we don't want saveSignal to fail. ensureSchemas() will
  // create it on the next engine call.
  await db.query(
    `INSERT INTO q365_signal_lifecycle (signal_id, state, reason, changed_at)
     VALUES (?, 'generated', 'signal_engine_persist', ?)`,
    [signalId, toMysqlDateTime(s.generatedAt)],
  ).catch((err) => {
    console.error(`[SignalEngine] seed lifecycle failed for signal ${signalId}:`, err);
  });

  // 5. Maturity tracker upsert (signal maturity layer).
  //
  //    saveSignals NEVER inserts directly into the confirmed-snapshot
  //    table. Every detection enters the maturity tracker keyed by
  //    (symbol, direction). Subsequent re-detections by later scanner
  //    runs increment validation_cycles_passed. The maturity worker
  //    (60s cadence) walks the tracker, scores maturity, and only
  //    promotes rows that have:
  //      - maturity_score ≥ 85
  //      - validation_cycles_passed ≥ 3
  //      - signal_age_minutes ≥ 10
  //      - stable trade plan across cycles
  //
  //    This is the principle: don't optimise for the earliest signal,
  //    optimise for the trustworthy one. A symbol that flashes once
  //    on a one-bar volume spike never accrues enough cycles or
  //    stability to clear the maturity threshold.
  //
  //    Wrapped in try/catch so tracker failures never break the
  //    q365_signals write path.
  try {
    const trackerResult = await upsertTrackerOnDetection({
      symbol:      s.symbol,
      direction,
      signal_id:   signalId,
      entry_price: Number(entryPrice),
      stop_loss:   Number(stopLoss),
      target1:     Number(target1),
      confidence:  Number(s.confidenceScore ?? 0),
      final_score: phase4FinalScore != null ? Number(phase4FinalScore) :
                   seedRank.finalScore != null ? Number(seedRank.finalScore) : null,
      decay_state: seedFreshness.decayState ?? null,
    });
    if (trackerResult.reset) {
      // Surface the explicit reset reason ('terminated' vs 'stale') and
      // the elapsed minutes so an operator can tell from the log alone
      // whether the reset was a legitimate lifecycle event or a
      // configuration smell (e.g. TRACKER_STALE_RESET_MIN below the
      // active scan cadence — which used to bake in the 60-min default
      // and produced the "Cycle 1 lock" symptom).
      const sinceLast = trackerResult.minutesSinceLastSeen != null
        ? `${trackerResult.minutesSinceLastSeen.toFixed(0)}min`
        : 'n/a';
      console.log(
        `[saveSignals] tracker RESET ${s.symbol} ${direction} ` +
        `reason=${trackerResult.resetReason} ` +
        `since_last_seen=${sinceLast} ` +
        `threshold=${trackerResult.staleResetThresholdMin}min ` +
        `→ cycle 1`,
      );
    } else if (trackerResult.cycles > 1) {
      console.log(`[saveSignals] tracker bump ${s.symbol} ${direction} cycle=${trackerResult.cycles} stage=${trackerResult.stage}`);
    }
  } catch (err: any) {
    console.warn(`[saveSignals] maturity-tracker path threw for ${s.symbol}:`, err?.message);
  }

  return { kind: 'saved', id: signalId };
}

export async function getLatestSignals(limit = 20): Promise<any[]> {
  const result = await db.query(
    `SELECT s.*,
            GROUP_CONCAT(CASE WHEN r.reason_type = 'reason' THEN r.message END SEPARATOR '||') AS reasons_raw,
            GROUP_CONCAT(CASE WHEN r.reason_type = 'warning' THEN r.message END SEPARATOR '||') AS warnings_raw
     FROM q365_signals s
     LEFT JOIN q365_signal_reasons r ON r.signal_id = s.id
     WHERE s.status IN ('active', 'watchlist')
     GROUP BY s.id
     ORDER BY s.confidence_score DESC, s.risk_score ASC
     LIMIT ?`,
    [limit],
  );

  const rows: any[] = result.rows ?? [];
  return rows.map((row: any) => ({
    symbol: row.symbol,
    timeframe: row.timeframe,
    signalType: row.signal_type,
    action: row.action_type,
    confidenceScore: row.confidence_score,
    confidenceBand: row.confidence_band,
    riskScore: row.risk_score,
    riskBand: row.risk_band,
    marketRegime: row.market_regime,
    entry: {
      type: 'breakout_confirmation' as const,
      zoneLow: row.entry_zone_low,
      zoneHigh: row.entry_zone_high,
    },
    stopLoss: row.stop_loss,
    targets: {
      target1: row.target1,
      target2: row.target2,
    },
    rewardRiskApprox: row.reward_risk_approx,
    reasons: row.reasons_raw ? row.reasons_raw.split('||') : [],
    warnings: row.warnings_raw ? row.warnings_raw.split('||') : [],
    status: row.status,
    generatedAt: row.generated_at,
  }));
}
