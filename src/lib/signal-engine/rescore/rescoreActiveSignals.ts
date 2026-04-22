// ════════════════════════════════════════════════════════════════
//  Rescore Active Signals — Phase 4 (Dynamic Ranking Engine)
//
//  The loop that turns the signal dashboard from a frozen snapshot
//  into a live ranking. Runs on a 5-minute cron during market hours
//  (wired from src/lib/workers/scheduler.ts).
//
//  Flow per tick:
//    1. SELECT active/watchlist/flagged signals from q365_signals.
//    2. Batch-resolve live LTPs via MarketDataResolver (Kite
//       primary, Yahoo fallback — same path saveSignals uses, so
//       we don't diverge on source-of-truth for price).
//    3. For each row:
//         - freshnessEngine → ageBars, freshnessScore, decayState,
//                             overextensionPct, entryMissed, adverseR
//         - postSignalValidator → verdict (keep | downgrade | invalidate)
//         - dynamicRanker → finalScore
//    4. Persist in a single multi-row UPDATE per batch (chunked to
//       avoid max_allowed_packet issues on huge result sets).
//
//  This module owns no schedule — it exposes one function,
//  `rescoreActiveSignals()`, that the cron (or a POST admin route)
//  can invoke.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { resolvePrices } from '@/lib/marketData/MarketDataResolver';
import { computeFreshnessReport } from '../freshness/freshnessEngine';
import { validatePostSignal } from '../validation/postSignalValidator';
import { computeFinalScore } from '../ranking/dynamicRanker';
import type { SignalDirection } from '../freshness/freshnessEngine';

export interface RescoreResult {
  scanned:         number;
  updated:         number;
  invalidated:     number;
  downgraded:      number;
  skippedNoPrice:  number;
  // ── Per-cycle data-source metrics ────────────────────────
  // These answer the operator's "is Kite actually working?"
  // question without requiring a separate health probe. If
  // kiteHits drops to 0 while yahooHits climbs, the Kite
  // websocket is stale or disconnected — check loginRequired.
  kiteHits:        number;
  yahooHits:       number;
  otherHits:       number;   // cache / DB / unknown source
  failedFetches:   number;   // symbols resolver returned null for
  // staleRescored: rows processed with entry_price as a proxy for
  // current price because no live feed was available. Age-based
  // rules (step penalty, max_lifetime cap) still fire; price-based
  // rules (stop, target, overextension) are skipped. This is what
  // lets rotation progress during closed-market hours.
  staleRescored:   number;
  elapsedMs:       number;
}

interface ActiveRow {
  id:                  number;
  symbol:              string;
  direction:           SignalDirection;
  entry_price:         string | number;
  stop_loss:           string | number;
  target1:             string | number;
  confidence_score:    number;
  regime_alignment:    number | null;
  portfolio_fit_score: number | null;
  market_stance:       string | null;
  generated_at:        string;
  status:              string;
}

// Guard against overlapping runs when a rescore takes longer than
// the 5-minute cron interval (slow VPS, DB contention). The cron
// should no-op rather than queue.
let inFlight: Promise<RescoreResult> | null = null;

export function rescoreActiveSignals(): Promise<RescoreResult> {
  if (inFlight) {
    console.warn('[rescore] previous run still in flight — skipping this tick');
    return inFlight;
  }
  inFlight = runOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function runOnce(): Promise<RescoreResult> {
  const started = Date.now();
  const result: RescoreResult = {
    scanned: 0, updated: 0, invalidated: 0,
    downgraded: 0, skippedNoPrice: 0,
    kiteHits: 0, yahooHits: 0, otherHits: 0, failedFetches: 0,
    staleRescored: 0,
    elapsedMs: 0,
  };

  const { rows } = await db.query<ActiveRow>(
    `SELECT id, symbol, direction, entry_price, stop_loss, target1,
            confidence_score, regime_alignment, portfolio_fit_score,
            market_stance, generated_at, status
       FROM q365_signals
      WHERE status IN ('active', 'watchlist', 'flagged')`,
  );

  result.scanned = rows.length;
  if (rows.length === 0) {
    result.elapsedMs = Date.now() - started;
    console.log(`[RESCORE] cycle skipped — no active signals (elapsed ${result.elapsedMs}ms)`);
    return result;
  }

  // ── Batch live LTP resolution ──────────────────────────────
  // resolvePrices chains Kite → IndianAPI cache → Yahoo → DB per
  // symbol. We capture both price AND source so the cycle log can
  // tell the operator whether Kite is actually delivering ticks
  // or the system is quietly running on Yahoo's 15-min delayed feed.
  const fetchStarted = Date.now();
  const uniqueSymbols = Array.from(new Set(rows.map(r => r.symbol)));
  const quotes = await resolvePrices(uniqueSymbols, { concurrency: 12 });
  const fetchMs = Date.now() - fetchStarted;

  const priceBySymbol = new Map<string, number>();
  for (const q of quotes) {
    if (q.symbol && q.price != null && q.price > 0) {
      priceBySymbol.set(q.symbol.toUpperCase(), Number(q.price));
      const src = String(q.source ?? '').toLowerCase();
      if (src.includes('kite')) result.kiteHits++;
      else if (src.includes('yahoo')) result.yahooHits++;
      else result.otherHits++;
    } else {
      result.failedFetches++;
    }
  }

  // ── Optional enrichments (one query each — keep the loop O(1) per row) ─
  const signalIds = rows.map(r => r.id);
  const manipulationById = await fetchManipulationPenalties(signalIds);
  const eventRiskBySymbol = await fetchEventRisk(uniqueSymbols);

  // ── Row-by-row scoring ─────────────────────────────────────
  type Update = {
    id:        number;
    finalScore:        number;
    freshnessScore:    number;
    decayState:        string;
    ageBars:           number;
    overextensionPct:  number;
    invalidationReason: string | null;
    invalidatedAt:     string | null;
    nextStatus:        string;
  };
  const updates: Update[] = [];

  for (const row of rows) {
    const entry  = Number(row.entry_price);
    const stop   = Number(row.stop_loss);
    const target = Number(row.target1);
    if (!isFinite(entry) || !isFinite(stop) || !isFinite(target)) continue;

    // ── Live price with graceful age-only fallback ─────────
    // When the market is closed, Kite is down, or the provider
    // chain otherwise fails for this symbol, fall back to the
    // original entry price as the "current" value. Freshness
    // computes movePct=0 and adverseR=0, so:
    //   - price-based rules (stop, target, overextension, drift)
    //     DON'T fire — we won't fabricate invalidations from a
    //     price we didn't actually observe.
    //   - age-based rules (step penalty, max_lifetime_reached)
    //     DO fire — because ageBars depends only on generated_at.
    // Result: signals still rotate off the board during closed
    // hours instead of freezing at whatever score they had at
    // Friday close. The only unfreshness is the freshness score
    // itself, which is exactly what we want.
    const rawLivePrice = priceBySymbol.get(row.symbol.toUpperCase());
    const priceAvailable = rawLivePrice != null;
    const livePrice = priceAvailable ? rawLivePrice : entry;
    if (!priceAvailable) result.staleRescored++;

    const freshness = computeFreshnessReport({
      generatedAt:  String(row.generated_at),
      direction:    row.direction,
      entryPrice:   entry,
      stopLoss:     stop,
      target1:      target,
      currentPrice: livePrice,
    });

    const verdict = validatePostSignal({
      direction:    row.direction,
      entryPrice:   entry,
      stopLoss:     stop,
      target1:      target,
      currentPrice: livePrice,
      freshness,
    });

    const breakdown = computeFinalScore({
      confidenceScore:     row.confidence_score,
      regimeAlignment:     row.regime_alignment,
      portfolioFit:        row.portfolio_fit_score,
      marketStance:        row.market_stance,
      direction:           row.direction,
      eventRiskScore:      eventRiskBySymbol.get(row.symbol.toUpperCase()) ?? null,
      manipulationPenalty: manipulationById.get(row.id) ?? null,
      freshness,
      verdict,
    });

    if (verdict.action === 'invalidate') result.invalidated++;
    else if (verdict.action === 'downgrade') result.downgraded++;

    updates.push({
      id:                 row.id,
      finalScore:         breakdown.finalScore,
      freshnessScore:     freshness.freshnessScore,
      decayState:         freshness.decayState,
      ageBars:            freshness.ageBars,
      overextensionPct:   freshness.overextensionPct,
      invalidationReason: verdict.reason,
      invalidatedAt:      verdict.action === 'invalidate' ? mysqlNow() : null,
      nextStatus:         verdict.nextStatus,
    });
  }

  // ── Persist in chunks (CASE-WHEN gets unwieldy past ~500 rows) ─
  const CHUNK = 300;
  let raceSkipped = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const { attempted, affected } = await persistChunk(updates.slice(i, i + CHUNK));
    result.updated += affected;
    raceSkipped += attempted - affected;
  }
  if (raceSkipped > 0) {
    console.log(
      `[RESCORE] optimistic-concurrency skipped ${raceSkipped} rows ` +
      `(regen/expiry won the race — this is expected under load, not an error)`,
    );
  }

  result.elapsedMs = Date.now() - started;

  // ── Block-style cycle log (operator-friendly) ─────────────
  const pctKite = result.scanned > 0
    ? Math.round(100 * result.kiteHits / result.scanned)
    : 0;
  const feedHealth = pctKite >= 90 ? 'LIVE (Kite)'
    : pctKite >= 30 ? 'DEGRADED (mixed)'
    : result.yahooHits > 0 ? 'FALLBACK (Yahoo ~15min delay)'
    : 'FAIL (no data)';

  console.log(
    `[ENGINE] Symbols scanned: ${result.scanned}\n` +
    `[ENGINE] Data fetched: ${result.kiteHits + result.yahooHits + result.otherHits} success, ${result.failedFetches} failed\n` +
    `[ENGINE] Source breakdown: kite=${result.kiteHits} yahoo=${result.yahooHits} other=${result.otherHits}\n` +
    `[ENGINE] Signals updated: ${result.updated}  invalidated: ${result.invalidated}  downgraded: ${result.downgraded}  age-only: ${result.staleRescored}\n` +
    `[ENGINE] Feed health: ${feedHealth} (${pctKite}% Kite)\n` +
    `[ENGINE] Cycle time: ${(result.elapsedMs / 1000).toFixed(1)} sec`,
  );
  return result;
}

// ── Chunked persist ──────────────────────────────────────────────
//
// One multi-row UPDATE via CASE-WHEN is ~5× faster than N separate
// UPDATEs on a busy MySQL instance, which matters when the cron is
// touching 500-2000 rows every 5 minutes.
//
// Race-safety (optimistic concurrency): the UPDATE's WHERE clause
// guards against regen having expired the rows between our SELECT
// and this UPDATE. Without these guards we'd un-expire rows that
// the 10-min regen just rotated off — see production audit Bug #2.
//
// Returns { attempted, affected } so the caller can log the delta.
// A non-zero delta ("race detected") is informational, not an error
// — it just means regen won the race for some rows, which is fine.
async function persistChunk(
  chunk: Array<{
    id: number;
    finalScore: number;
    freshnessScore: number;
    decayState: string;
    ageBars: number;
    overextensionPct: number;
    invalidationReason: string | null;
    invalidatedAt: string | null;
    nextStatus: string;
  }>,
): Promise<{ attempted: number; affected: number }> {
  if (chunk.length === 0) return { attempted: 0, affected: 0 };

  const ids = chunk.map(u => u.id);
  const placeholders = ids.map(() => '?').join(',');

  // Build CASE WHEN id = ? THEN ? expressions column by column.
  const params: any[] = [];
  const caseFor = (col: string, values: Array<number | string | null>): string => {
    const clauses = chunk.map((u, idx) => {
      params.push(u.id, values[idx]);
      return 'WHEN ? THEN ?';
    }).join(' ');
    return `${col} = CASE id ${clauses} END`;
  };

  // The WHERE clause now enforces three invariants:
  //   1. The row must still be active/watchlist/flagged — regen may
  //      have expired it via its batch UPDATE in saveSignals.
  //   2. expires_at (if set) must not be in the past — prevents a
  //      rescore from resurrecting a row past its hard lifetime cap.
  //   3. invalidation_reason must still be NULL — we never UPDATE a
  //      row that's already been invalidated by a previous cycle.
  // MySQL treats these as an all-or-nothing match per row: if any
  // guard fails, that row's UPDATE is silently skipped (no error).
  const sql = `
    UPDATE q365_signals SET
      ${caseFor('final_score',          chunk.map(u => u.finalScore))},
      ${caseFor('freshness_score',      chunk.map(u => u.freshnessScore))},
      ${caseFor('decay_state',          chunk.map(u => u.decayState))},
      ${caseFor('age_bars',             chunk.map(u => u.ageBars))},
      ${caseFor('overextension_pct',    chunk.map(u => u.overextensionPct))},
      ${caseFor('invalidation_reason',  chunk.map(u => u.invalidationReason))},
      ${caseFor('invalidated_at',       chunk.map(u => u.invalidatedAt))},
      ${caseFor('status',               chunk.map(u => u.nextStatus))},
      last_rescored_at = ?
     WHERE id IN (${placeholders})
       AND status IN ('active','watchlist','flagged')
       AND (expires_at IS NULL OR expires_at > NOW())
       AND invalidation_reason IS NULL
  `;
  params.push(mysqlNow(), ...ids);

  const result = await db.query(sql, params);
  const affected = result.affectedRows ?? chunk.length;
  return { attempted: chunk.length, affected };
}

// ── Enrichment fetchers ─────────────────────────────────────────

async function fetchManipulationPenalties(signalIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (signalIds.length === 0) return out;
  try {
    const placeholders = signalIds.map(() => '?').join(',');
    const { rows } = await db.query<{ signal_id: string; confidence_penalty: number }>(
      `SELECT signal_id, confidence_penalty
         FROM q365_manipulation_penalties
        WHERE signal_id IN (${placeholders})`,
      signalIds.map(id => String(id)),
    );
    for (const r of rows) {
      const idNum = Number(r.signal_id);
      if (isFinite(idNum)) out.set(idNum, Number(r.confidence_penalty) || 0);
    }
  } catch {
    // Manipulation tables are optional — a missing table is not an
    // error for the ranker, just no penalty applied.
  }
  return out;
}

async function fetchEventRisk(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (symbols.length === 0) return out;
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const { rows } = await db.query<{ symbol: string; event_risk: number }>(
      `SELECT symbol, MAX(final_event_risk) AS event_risk
         FROM q365_news_impact
        WHERE symbol IN (${placeholders})
          AND created_at >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
        GROUP BY symbol`,
      symbols,
    );
    for (const r of rows) {
      out.set(String(r.symbol).toUpperCase(), Number(r.event_risk) || 0);
    }
  } catch {
    // News-impact table may not exist in every deployment (Phase 4
    // partial) — null eventRisk defaults to zero penalty.
  }
  return out;
}

function mysqlNow(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
