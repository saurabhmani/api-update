/**
 * GET /api/intelligence
 *
 * Returns categorized, strategy-grouped signal intelligence from the database.
 * Used by the /intelligence page.
 *
 * Response:
 *   buySignals     — BUY signals grouped by strategy (bullish_breakout, bullish_pullback, etc.)
 *   sellSignals    — SELL signals grouped by strategy (bearish_breakdown, mean_reversion_fade, etc.)
 *   by_direction   — flat grouping by BUY/SELL/HOLD
 *   by_strategy    — all signals grouped by strategy_group
 *   by_conviction  — signals grouped by conviction band
 *   summary        — aggregate stats (total, buy, sell, avg_confidence, conviction_distribution)
 *   market_stance  — current market stance + guidance + config
 *   regime         — current market regime
 *   scenario       — current scenario classification
 *   stats          — 7-day conviction & scenario breakdown
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession }           from '@/lib/session';
import {
  getIntelligenceSignals,
  getSignalStats,
  getLatestRegime,
}                                    from '@/lib/signal-engine/repository/readSignals';
import { computeScenario }           from '@/services/scenarioEngine';
import { computeMarketStance }       from '@/services/marketStanceEngine';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// Module-level SWR cache. The /intelligence dashboard now polls every
// 1s — without this cache, every connected client would translate into
// 1 DB-heavy intelligence build per second (4 parallel queries +
// computeScenario + computeMarketStance). With the cache, a single
// process serves all subscribers from one in-memory snapshot that
// refreshes ~once per second.
//
// Pattern matches /api/signals/stream's signalsCache: fresh window
// returns instantly; stale cache returns cached data AND fires a
// single-flight background refresh so the next caller sees fresh.
let intelligenceCache: { ts: number; payload: any } | null = null;
let intelligenceRefreshing = false;
// 4s window matches the /api/signals/stream cache. The intelligence build
// is heavier (4 parallel queries + computeScenario + computeMarketStance)
// so an 800ms window with 1-second client polls absolutely melts the
// MySQL pool. 4s keeps the dashboard feeling live while letting the DB
// breathe — only 1 in 4 polls actually queries; the rest are cache hits.
const INTEL_CACHE_FRESH_MS = 4_000;

async function buildIntelligencePayload(): Promise<any> {
  // Run in parallel: signals from DB + market context
  const [intelligenceRes, statsRes, regimeRes, scenarioRes] = await Promise.allSettled([
    getIntelligenceSignals(),
    getSignalStats(),
    getLatestRegime(),
    computeScenario().catch(() => null),
  ]);

  const intelligence = intelligenceRes.status === 'fulfilled' ? intelligenceRes.value : null;
  const stats        = statsRes.status === 'fulfilled'        ? statsRes.value        : null;
  const regime       = regimeRes.status === 'fulfilled'       ? regimeRes.value       : 'NEUTRAL';
  const scenario     = scenarioRes.status === 'fulfilled'     ? scenarioRes.value     : null;

  // Compute stance from scenario
  const stance = scenario
    ? await computeMarketStance(scenario).catch(() => null)
    : null;

  return {
    // Strategy-grouped signals (Phase 2 format)
    buySignals:    intelligence?.buySignals    ?? {},
    sellSignals:   intelligence?.sellSignals   ?? {},
    by_direction:  intelligence?.by_direction  ?? {},
    by_strategy:   intelligence?.by_strategy   ?? {},
    by_conviction: intelligence?.by_conviction ?? {},
    summary: intelligence?.summary ?? {
      total: 0, buy: 0, sell: 0, hold: 0,
      avg_confidence: 0, avg_rr: 0,
      buy_avg_confidence: 0, sell_avg_confidence: 0,
      conviction_distribution: { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 },
    },
    regime,
    scenario: scenario ? {
      tag:               scenario.scenario_tag,
      confidence:        scenario.scenario_confidence,
      stance_hint:       scenario.market_stance_hint,
      volatility_mode:   scenario.volatility_mode,
      breadth_state:     scenario.breadth_state,
      direction_bias:    scenario.direction_bias,
    } : null,
    market_stance: stance ? {
      stance:     stance.market_stance,
      confidence: stance.stance_confidence,
      guidance:   stance.guidance_message,
      rationale:  stance.rationale,
      config: {
        min_confidence:  stance.stance_config.min_confidence,
        min_rr:          stance.stance_config.min_rr,
        max_positions:   stance.stance_config.max_positions,
        risk_multiplier: stance.stance_config.risk_multiplier,
      },
    } : null,
    stats,
    source: 'database',
    as_of:  new Date().toISOString(),
  };
}

async function getIntelligencePayloadCached(): Promise<any> {
  const now = Date.now();
  // Warm + fresh — instant.
  if (intelligenceCache && now - intelligenceCache.ts < INTEL_CACHE_FRESH_MS) {
    return intelligenceCache.payload;
  }
  // Warm + stale — serve cached, refresh in background (single-flight).
  if (intelligenceCache && intelligenceRefreshing) {
    return intelligenceCache.payload;
  }
  if (intelligenceCache) {
    intelligenceRefreshing = true;
    void buildIntelligencePayload()
      .then((payload) => { intelligenceCache = { ts: Date.now(), payload }; })
      .catch((err) => console.warn('[/api/intelligence] background refresh failed:', err?.message))
      .finally(() => { intelligenceRefreshing = false; });
    return intelligenceCache.payload;
  }
  // Cold — synchronous build.
  const payload = await buildIntelligencePayload();
  intelligenceCache = { ts: Date.now(), payload };
  return payload;
}

// Note: not exported. Next.js's route-type validator restricts route
// files to a fixed set of named exports (GET/POST/dynamic/etc.), and
// the 800ms SWR window is short enough that a new batch lands within
// one push cycle anyway — no manual invalidation needed.

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
    const payload = await getIntelligencePayloadCached();
    return NextResponse.json(payload);
  } catch (err: any) {
    console.error('[/api/intelligence]', err?.message);
    return NextResponse.json({ error: 'Failed to fetch intelligence' }, { status: 500 });
  }
}
