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

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
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

    return NextResponse.json({
      // Strategy-grouped signals (Phase 2 format)
      buySignals:    intelligence?.buySignals    ?? {},
      sellSignals:   intelligence?.sellSignals   ?? {},

      // Flat groupings (backward compatible)
      by_direction:  intelligence?.by_direction  ?? {},
      by_strategy:   intelligence?.by_strategy   ?? {},
      by_conviction: intelligence?.by_conviction ?? {},

      // Summary with conviction distribution
      summary: intelligence?.summary ?? {
        total: 0, buy: 0, sell: 0, hold: 0,
        avg_confidence: 0, avg_rr: 0,
        buy_avg_confidence: 0, sell_avg_confidence: 0,
        conviction_distribution: { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 },
      },

      // Market context
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

      // 7-day stats
      stats,

      // Metadata
      source: 'database',
      as_of:  new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[/api/intelligence]', err?.message);
    return NextResponse.json({ error: 'Failed to fetch intelligence' }, { status: 500 });
  }
}
