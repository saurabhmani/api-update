/**
 * GET /api/market-intelligence
 *
 * Returns full market intelligence including:
 *   - Market trend, breadth, sector strength, FII/DII, volatility
 *   - Scenario (trend_continuation, breakout_expansion, etc.)
 *   - Market stance (aggressive / selective / defensive / capital_preservation)
 *   - Regime
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { computeMarketIntelligence }  from '@/services/marketIntelligenceService';
import { computeScenario }            from '@/services/scenarioEngine';
import { computeMarketStance }        from '@/services/marketStanceEngine';
import { cacheGet }                   from '@/lib/redis';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
    // Step 1: compute market intelligence FIRST — scenario reads from its cache.
    // Running them in parallel causes scenario to see an empty intel cache on cold start.
    const [intelRes, regimeRes] = await Promise.allSettled([
      computeMarketIntelligence(),
      cacheGet<{ regime: string; set_at?: string }>('market:regime'),
    ]);

    const intel  = intelRes.status === 'fulfilled'  ? intelRes.value  : null;
    const regime = regimeRes.status === 'fulfilled' ? regimeRes.value : null;

    // Step 2: scenario and stance now read from the freshly cached intelligence.
    const scenario = await computeScenario().catch(() => null);
    const stance = scenario
      ? await computeMarketStance(scenario).catch(() => null)
      : null;


    // Regime priority — unified with the signal engine's
    // UNIFIED ENGINE SUMMARY output so the dashboard can never
    // disagree with the pipeline log:
    //   1. intel.regime_label (NIFTY-50 EMA/RSI — same code path
    //      the pipeline's detectEnhancedRegime call uses)
    //   2. Fresh trend_score buckets (breadth fallback)
    //   3. scenario.direction_bias
    //   4. Cached market:regime ONLY if set within last 4h
    //   5. NEUTRAL
    const trendScore = intel?.trend_score ?? 0;
    let derivedRegime: string;
    if (intel?.regime_label) {
      derivedRegime = intel.regime_label;        // e.g. 'Strong Bullish'
    } else if (intel) {
      if      (trendScore >=  40) derivedRegime = 'Bullish';
      else if (trendScore <= -40) derivedRegime = 'Bearish';
      else                         derivedRegime = 'Neutral';
    } else if (scenario?.direction_bias) {
      derivedRegime = scenario.direction_bias;
    } else if (regime?.regime && regime.set_at) {
      const ageMs = Date.now() - new Date(regime.set_at).getTime();
      derivedRegime = ageMs < 4 * 3600_000 ? regime.regime : 'Neutral';
    } else {
      derivedRegime = 'Neutral';
    }
    console.log(
      `[API/market-intelligence] regime=${derivedRegime}  ` +
      `trendScore=${trendScore}  marketTrend=${intel?.market_trend ?? '-'}  ` +
      `source=${intel?.regime_label ? 'engine' : 'breadth'}`
    );

    return NextResponse.json({
      // Market direction
      marketTrend:  intel?.market_trend  ?? 'Neutral',
      trendScore,
      regime:       derivedRegime,
      regimeConfidence: intel?.regime_confidence ?? null,
      regimeReason:     intel?.regime_reason     ?? null,
      weakMarket:       intel?.weak_market       ?? false,

      breadth: {
        advancing: intel?.advancing ?? 0,
        declining: intel?.declining ?? 0,
        unchanged: intel?.unchanged ?? 0,
        ratio:     (intel?.advancing ?? 0) + (intel?.declining ?? 0) > 0
          ? parseFloat(((intel!.advancing) / (intel!.advancing + intel!.declining)).toFixed(2))
          : null,
      },

      // Sector breakdown
      sectorStrength: intel?.sector_strength ?? [],

      // Movers
      topGainers: intel?.top_gainers ?? [],
      topLosers:  intel?.top_losers  ?? [],

      // Institutional flow
      fiiDii: intel?.fii_dii ?? [],

      // Volatility
      volatility: intel?.volatility ?? { nifty_vix: null, avg_range_pct: 0, volatility_label: 'Unknown', high_vol_count: 0 },

      // Scenario intelligence
      scenario: scenario ? {
        tag:               scenario.scenario_tag,
        confidence:        scenario.scenario_confidence,
        stance_hint:       scenario.market_stance_hint,
        volatility_mode:   scenario.volatility_mode,
        breadth_state:     scenario.breadth_state,
        direction_bias:    scenario.direction_bias,
        regime_alignment:  scenario.regime_alignment,
        allowed_strategies:scenario.allowed_strategies,
        blocked_strategies:scenario.blocked_strategies,
      } : null,

      // Market stance
      market_stance: stance ? {
        stance:          stance.market_stance,
        confidence:      stance.stance_confidence,
        guidance:        stance.guidance_message,
        rationale:       stance.rationale,
        rejection_rate:  stance.rejection_rate,
        avg_confidence:  stance.avg_top_confidence,
        config: {
          min_confidence:  stance.stance_config.min_confidence,
          min_rr:          stance.stance_config.min_rr,
          max_positions:   stance.stance_config.max_positions,
          risk_multiplier: stance.stance_config.risk_multiplier,
        },
      } : null,

      // Metadata
      meta: {
        asOf:        intel?.as_of        ?? new Date().toISOString(),
        dataSource:  intel?.data_source  ?? 'unknown',
        cacheAgeSec: intel?.cache_age_sec ?? null,
        regimeSetAt: regime?.set_at       ?? null,
      },
    });
  } catch (err: any) {
    console.error('[/api/market-intelligence]', err?.message);
    return NextResponse.json({ error: 'Failed to compute market intelligence' }, { status: 500 });
  }
}
