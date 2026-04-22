// ════════════════════════════════════════════════════════════════
//  Signal Persistence — MySQL
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { QuantSignal, StrategyName } from '../types/signalEngine.types';
import { makeProvenance, type EngineProvenance } from '../constants/engineVersion';
import { getSector, deriveVolatilityState } from '../constants/phase3.constants';
import { resolvePrice } from '@/lib/marketData/MarketDataResolver';
import { computeFreshnessReport } from '../freshness/freshnessEngine';
import { validatePostSignal } from '../validation/postSignalValidator';
import { computeFinalScore } from '../ranking/dynamicRanker';

// Maximum acceptable gap between the strategy-derived entry price
// (built from daily candles, possibly hours stale) and the live
// LTP at signal-write time. Any signal whose entry zone is more than
// this fraction away from the live tape is rejected as untradeable —
// the trade plan would otherwise tell a trader to enter at a price
// the market has already moved past.
const MAX_ENTRY_GAP_PCT = 0.05; // 5%

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
    await db.query(
      `UPDATE q365_signals SET status = 'expired'
       WHERE (${expireClauses.join(' OR ')})
         AND status IN ('active', 'watchlist')`,
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
  return idMap;
}

async function saveOneSignal(s: QuantSignal, provenance: EngineProvenance): Promise<SaveOutcome> {
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
  try {
    const dup = await db.query(
      `SELECT id FROM q365_signals
       WHERE symbol = ? AND direction = ? AND status IN ('active','watchlist')
       LIMIT 1`,
      [s.symbol, direction],
    );
    if (((dup.rows as any[]) ?? []).length > 0) {
      console.warn(`[saveSignals] DEDUPE ${s.symbol}:${direction} — active row already exists in DB, skipping`);
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

  const result: any = await db.query(
    `INSERT INTO q365_signals
      (symbol, instrument_key, exchange, direction, timeframe, signal_type,
       confidence_score, confidence_band, risk_score, risk_band,
       entry_price, stop_loss, target1, target2, risk_reward,
       market_regime, status, generated_at,
       opportunity_score, scenario_tag, market_stance, factor_scores_json,
       sector, volatility_state,
       portfolio_fit_score, regime_alignment, ltp, pct_change, batch_id,
       engine_phase, engine_version, generation_source, code_build,
       final_score, freshness_score, decay_state, age_bars,
       overextension_pct, last_rescored_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      s.symbol, `NSE_EQ|${s.symbol}`, 'NSE', direction,
      s.timeframe, s.signalType,
      s.confidenceScore, s.confidenceBand,
      s.riskScore, s.riskBand,
      entryPrice, stopLoss, target1, target2,
      riskReward, s.marketRegime,
      s.status === 'active' ? 'active' : s.status === 'watchlist' ? 'watchlist' : 'active',
      toMysqlDateTime(s.generatedAt),
      opportunityScore, scenarioTag, marketStance, factorScoresJson,
      sector, volatilityState,
      portfolioFitScore, regimeAlignment, ltpValue, livePctChange, provenance.generation_source,
      provenance.engine_phase, provenance.engine_version,
      provenance.generation_source, provenance.code_build,
      seedRank.finalScore, seedFreshness.freshnessScore, seedFreshness.decayState, seedFreshness.ageBars,
      seedFreshness.overextensionPct, toMysqlDateTime(nowIso), expiresAt,
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
