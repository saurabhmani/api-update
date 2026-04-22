/**
 * GET /api/dashboard
 *
 * Returns everything the dashboard needs in one concurrent call:
 *   - Rankings (from rankings table)
 *   - Top signals (from q365_signals — DB only, no live compute)
 *   - Market regime + scenario + stance
 *   - Portfolio summary with exposure
 *   - Signal quality stats
 */
import { NextResponse }               from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import { cacheGet }                   from '@/lib/redis';
import { getRankings }                from '@/services/rankingsService';
import { getTopSignals, getLatestRegime } from '@/lib/signal-engine/repository/readSignals';
import { computeScenario }            from '@/services/scenarioEngine';
import { computeMarketStance }        from '@/services/marketStanceEngine';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
    const [scenarioRes, rankingsResult, regimeRes, topSignalsRes, portfolioData, signalStats] =
      await Promise.allSettled([
        computeScenario(),

        getRankings({ limit: 10 }),

        getLatestRegime(),

        // Read top signals from DB — no live computation
        getTopSignals(6),

        (async () => {
          try {
            const { rows: pRows } = await db.query(
              `SELECT id FROM portfolios WHERE user_id=? LIMIT 1`, [user.id]
            );
            if (!pRows.length) return null;
            const portfolioId = (pRows[0] as any).id;
            const { rows: pos } = await db.query(
              `SELECT pp.quantity, pp.buy_price, pp.current_price,
                      COALESCE(i.sector,'Other') AS sector
               FROM portfolio_positions pp
               LEFT JOIN instruments i ON pp.instrument_id = i.id
               WHERE pp.portfolio_id=?`,
              [portfolioId]
            );
            const invested = pos.reduce((s:number,r:any) => s + (r.quantity||0)*(r.buy_price||0), 0);
            const current  = pos.reduce((s:number,r:any) => s + (r.quantity||0)*(r.current_price||r.buy_price||0), 0);
            const pnl      = current - invested;
            const pnl_pct  = invested > 0 ? (pnl / invested) * 100 : 0;

            const sectorMap: Record<string,number> = {};
            for (const p of pos as any[]) {
              const s = p.sector || 'Other';
              sectorMap[s] = (sectorMap[s] || 0) + (p.quantity||0)*(p.current_price||p.buy_price||0);
            }
            const sectorPct = Object.fromEntries(
              Object.entries(sectorMap).map(([s,v]) => [s, current>0 ? parseFloat((v/current*100).toFixed(1)) : 0])
            );
            const warnings: string[] = [];
            for (const [s, pct] of Object.entries(sectorPct)) {
              if (pct > 30) warnings.push(`${s} at ${pct}% — exceeds 30% sector cap`);
            }

            return { positions: pos.length, invested, current, pnl, pnl_pct, sector_pct: sectorPct, warnings };
          } catch { return null; }
        })(),

        (async () => {
          try {
            const { rows } = await db.query(`
              SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
                AVG(confidence_score) AS avg_confidence
              FROM q365_signals
              WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
              LIMIT 1
            `);
            const r   = (rows[0] as any) ?? {};
            const tot = Number(r.total || 0);
            return {
              total:          tot,
              active:         Number(r.active || 0),
              avg_confidence: r.avg_confidence ? Math.round(Number(r.avg_confidence)) : null,
            };
          } catch { return null; }
        })(),
      ]);

    const scenario  = scenarioRes.status === 'fulfilled'  ? scenarioRes.value : null;
    const stance    = scenario ? await computeMarketStance(scenario).catch(() => null) : null;
    const rankings  = rankingsResult.status === 'fulfilled' ? rankingsResult.value : null;
    const regime    = regimeRes.status === 'fulfilled'      ? regimeRes.value : 'NEUTRAL';
    const topSigs   = topSignalsRes.status === 'fulfilled'  ? topSignalsRes.value : [];
    const portfolio = portfolioData.status === 'fulfilled'  ? portfolioData.value : null;
    const sigStats  = signalStats.status === 'fulfilled'    ? signalStats.value : null;

    return NextResponse.json({
      // Intelligence
      regime,
      scenario: scenario ? {
        tag:               scenario.scenario_tag,
        confidence:        scenario.scenario_confidence,
        stance_hint:       scenario.market_stance_hint,
        volatility_mode:   scenario.volatility_mode,
        breadth_state:     scenario.breadth_state,
        allowed_strategies:scenario.allowed_strategies,
      } : null,
      market_stance: stance ? {
        stance:           stance.market_stance,
        confidence:       stance.stance_confidence,
        guidance:         stance.guidance_message,
        rationale:        stance.rationale,
        config: {
          min_confidence:  stance.stance_config.min_confidence,
          min_rr:          stance.stance_config.min_rr,
          max_positions:   stance.stance_config.max_positions,
          risk_multiplier: stance.stance_config.risk_multiplier,
        },
      } : null,

      // Data — all from database
      rankings:      rankings?.data ?? [],
      top_signals:   topSigs,
      portfolio,
      signal_stats:  sigStats,
      source:        'database',
      as_of:         new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[/api/dashboard]', err?.message);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
