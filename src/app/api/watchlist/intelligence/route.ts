/**
 * GET /api/watchlist/intelligence
 *
 * Categorizes watchlist items into:
 *   actionable       — approved signal, high confidence
 *   emerging         — approaching actionable, watch closely
 *   blocked          — failed rejection engine with specific reasons
 *   low_confidence   — below conviction threshold
 *   regime_mismatch  — signal exists but blocked by regime/stance
 */
import { NextResponse }                     from 'next/server';
import { requireSession }                   from '@/lib/session';
import { db }                               from '@/lib/db';
import { generateSignal, opportunityScore } from '@/lib/signal-engine/live/analyzeInstrument';
import { cacheGet }                         from '@/lib/redis';
import type { MarketSnapshot }             from '@/services/marketDataService';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

type WatchlistCategory =
  | 'actionable'
  | 'emerging'
  | 'blocked'
  | 'low_confidence'
  | 'regime_mismatch'
  | 'no_data';

function categorize(sig: any | null, approved: boolean): WatchlistCategory {
  if (!sig) return 'no_data';
  if (approved && sig.conviction_band === 'high_conviction') return 'actionable';
  if (approved) return 'actionable';

  const codes: string[] = sig.rejection_codes ?? [];
  if (codes.includes('REGIME_MISMATCH') || codes.includes('STANCE_BLOCKED')) return 'regime_mismatch';
  if (codes.includes('LOW_CONFIDENCE'))  return 'low_confidence';
  if (sig.conviction_band === 'watchlist') return 'emerging';

  return 'blocked';
}

export async function GET() {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  let watchlistId: number | null = null;
  try {
    const { rows } = await db.query(`SELECT id FROM watchlists WHERE user_id=? LIMIT 1`, [user.id]);
    if (!rows.length) return NextResponse.json({ items: [], count: 0, categories: {} });
    watchlistId = (rows[0] as any).id;
  } catch { return NextResponse.json({ items: [], count: 0, categories: {} }); }

  let items: any[] = [];
  try {
    const { rows } = await db.query(
      `SELECT wi.instrument_key, wi.tradingsymbol, wi.exchange, wi.name
       FROM watchlist_items wi WHERE wi.watchlist_id=?`,
      [watchlistId]
    );
    items = rows as any[];
  } catch { return NextResponse.json({ items: [], count: 0, categories: {} }); }

  const scored = await Promise.all(items.map(async (item) => {
    const signal = await generateSignal(item.instrument_key, item.tradingsymbol, item.exchange);

    // Live price
    let ltp: number | null = null;
    let change_pct: number | null = null;
    try {
      const snap = await cacheGet<MarketSnapshot>(`stock:${item.tradingsymbol.toUpperCase()}`);
      if (snap?.ltp) { ltp = snap.ltp; change_pct = snap.change_percent; }
    } catch {}

    if (!signal) {
      return {
        ...item, ltp, change_pct,
        category:           'no_data' as WatchlistCategory,
        opportunity_score:  0,
        signal_direction:   'HOLD',
        signal_confidence:  null,
        confidence_score:   null,
        risk_score:         null,
        scenario_tag:       null,
        market_stance:      null,
        conviction_band:    null,
        regime:             null,
        entry_price:        null, stop_loss: null, target1: null, risk_reward: null,
        factor_scores:      null,
        portfolio_fit_score:null,
        approved:           false,
        rejection_reasons:  ['Market data unavailable'],
        rejection_codes:    [],
        soft_warnings:      [],
        blocked_by:         null,
        has_alert:          false,
      };
    }

    const approved = signal.rejection_reasons.length === 0 && signal.direction !== 'HOLD';
    const score    = opportunityScore(signal);
    const category = categorize(signal, approved);

    const momentumLabel =
      !approved                                             ? 'Below quality threshold' :
      signal.direction==='BUY'  && signal.confidence>=75   ? 'Strong Bullish' :
      signal.direction==='BUY'                             ? 'Mild Bullish'   :
      signal.direction==='SELL' && signal.confidence>=75   ? 'Strong Bearish' :
      signal.direction==='SELL'                            ? 'Mild Bearish'   : 'Neutral';

    return {
      ...item,
      ltp,
      change_pct,
      category,
      opportunity_score:   score,
      signal_direction:    signal.direction,
      signal_confidence:   signal.confidence,
      confidence_score:    signal.confidence,
      risk_score:          signal.risk_score,
      scenario_tag:        signal.scenario_tag,
      market_stance:       signal.market_stance,
      conviction_band:     signal.conviction_band,
      regime:              signal.regime,
      momentum_label:      momentumLabel,
      risk_level:          signal.risk,
      entry_price:         approved ? signal.entry_price  : null,
      stop_loss:           approved ? signal.stop_loss    : null,
      target1:             approved ? signal.target1      : null,
      risk_reward:         approved ? signal.risk_reward  : null,
      factor_scores:       signal.factor_scores,
      portfolio_fit_score: signal.portfolio_fit,
      confidence_components: signal.confidence_components,
      approved,
      rejection_reasons:   signal.rejection_reasons,
      rejection_codes:     signal.rejection_codes ?? [],
      soft_warnings:       signal.soft_warnings ?? [],
      blocked_by:          signal.blocked_by,
      top_reason:          approved ? (signal.reasons[0]?.text ?? null) : null,
      has_alert:           approved && score >= 75,
    };
  }));

  // Sort: actionable first, then emerging, then everything else
  const ORDER: Record<WatchlistCategory, number> = {
    actionable: 0, emerging: 1, regime_mismatch: 2,
    low_confidence: 3, blocked: 4, no_data: 5,
  };
  scored.sort((a, b) => {
    const catDiff = (ORDER[a.category as WatchlistCategory] ?? 5) - (ORDER[b.category as WatchlistCategory] ?? 5);
    if (catDiff !== 0) return catDiff;
    return b.opportunity_score - a.opportunity_score;
  });

  // Category summary
  const categories: Record<string, number> = {};
  for (const s of scored) {
    categories[s.category] = (categories[s.category] || 0) + 1;
  }

  return NextResponse.json({
    items:           scored,
    count:           scored.length,
    categories,
    approved_count:  scored.filter(s => s.approved).length,
    emerging_count:  scored.filter(s => s.category === 'emerging').length,
    blocked_count:   scored.filter(s => s.category === 'blocked').length,
    as_of:           new Date().toISOString(),
  });
}
