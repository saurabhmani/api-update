/**
 * Portfolio API — Quantorus365
 *
 * view=positions    — live-enriched positions
 * view=summary      — P&L summary
 * view=exposure     — sector concentration + strategy concentration + warnings
 * view=intelligence — regime-aware posture + risk budget + stance context
 */
import { NextRequest, NextResponse }      from 'next/server';
import { requireSession }                 from '@/lib/session';
import { db }                             from '@/lib/db';
import { cacheGet }                       from '@/lib/redis';
import { resolveByTicker }               from '@/services/instrumentResolver';
import type { MarketSnapshot }            from '@/services/marketDataService';
import type { PortfolioPosition,
              PortfolioSummary }          from '@/types';
import { getPortfolioContext,
         computePortfolioFit,
         persistExposureSnapshot }        from '@/services/portfolioFitService';
import { computeScenario }                from '@/services/scenarioEngine';
import { computeMarketStance }            from '@/services/marketStanceEngine';

export const dynamic = 'force-dynamic';

async function getOrCreatePortfolio(userId: number): Promise<number> {
  const { rows } = await db.query(`SELECT id FROM portfolios WHERE user_id=? LIMIT 1`, [userId]);
  if (rows.length) {
    const id = (rows[0] as any).id;
    console.log(`[PORTFOLIO] resolved existing portfolioId=${id} for userId=${userId}`);
    return id;
  }
  const r = await db.query(`INSERT INTO portfolios (user_id) VALUES (?)`, [userId]);
  // INSERT returns { rows: [], insertId, affectedRows } — the freshly
  // created portfolio id is on the envelope, not inside rows.
  const id = r.insertId ?? 0;
  console.log(`[PORTFOLIO] INSERT portfolios userId=${userId} insertId=${id}`);
  if (!id) console.error('[PORTFOLIO] ❌ insertId is 0/undefined — INSERT did not return an id');
  return id;
}

async function enrichWithLivePrices(positions: any[]): Promise<any[]> {
  return Promise.all(positions.map(async (p) => {
    try {
      const sym  = (p.tradingsymbol || '').toUpperCase();
      const snap = await cacheGet<MarketSnapshot>(`stock:${sym}`);
      if (snap?.ltp && snap.ltp > 0) {
        return {
          ...p,
          current_price:  snap.ltp,
          change_percent: snap.change_percent,
          change_abs:     snap.change_abs,
          price_source:   snap.source,
          data_quality:   snap.data_quality,
        };
      }
    } catch {}
    return { ...p, price_source: 'stored', data_quality: 0 };
  }));
}

// ── GET ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const view = req.nextUrl.searchParams.get('view') || 'positions';
  const portfolioId = await getOrCreatePortfolio(user.id).catch(() => 0);

  // ── Summary ───────────────────────────────────────────────────
  if (view === 'summary') {
    const { rows } = await db.query<PortfolioPosition>(
      `SELECT quantity, buy_price, current_price FROM portfolio_positions WHERE portfolio_id=?`,
      [portfolioId]
    );
    const invested  = rows.reduce((s,r) => s + r.quantity * r.buy_price, 0);
    const current   = rows.reduce((s,r) => s + r.quantity * (r.current_price||r.buy_price), 0);
    const total_pnl = current - invested;
    const pnl_pct   = invested ? (total_pnl / invested) * 100 : 0;
    return NextResponse.json({
      summary: { total_invested: invested, current_value: current, total_pnl, pnl_pct, positions_count: rows.length } as PortfolioSummary,
    });
  }

  // ── Positions with live prices ────────────────────────────────
  if (view === 'positions') {
    const { rows } = await db.query<PortfolioPosition>(
      `SELECT * FROM portfolio_positions WHERE portfolio_id=? ORDER BY added_at DESC`,
      [portfolioId]
    );
    const enriched   = await enrichWithLivePrices(rows as any[]);
    const totalValue = enriched.reduce((s,p) => s + (p.quantity||0)*(p.current_price||p.buy_price||0), 0);
    const totalCost  = enriched.reduce((s,p) => s + (p.quantity||0)*(p.buy_price||0), 0);
    return NextResponse.json({
      positions:    enriched,
      total_value:  parseFloat(totalValue.toFixed(2)),
      total_cost:   parseFloat(totalCost.toFixed(2)),
      total_pnl:    parseFloat((totalValue-totalCost).toFixed(2)),
      portfolio_id: portfolioId,
    });
  }

  // ── Sector exposure ───────────────────────────────────────────
  if (view === 'exposure') {
    const ctx      = await getPortfolioContext(user.id);
    const enriched = await enrichWithLivePrices(
      Object.keys(ctx.sector_counts).map(s => ({ tradingsymbol: s }))
    );

    // Compute concentration warnings
    const warnings: string[] = [];
    for (const [sector, pct] of Object.entries(ctx.sector_exposure_pct)) {
      if (pct >= 30) warnings.push(`${sector}: ${pct}% — exceeds 30% sector cap`);
    }
    for (const [strat, count] of Object.entries(ctx.strategy_counts)) {
      const total = Object.values(ctx.strategy_counts).reduce((a,b)=>a+b,0);
      if (total > 0 && count/total >= 0.5)
        warnings.push(`Strategy "${strat}" is ${(count/total*100).toFixed(0)}% of portfolio — concentrated`);
    }
    if (ctx.total_positions > 12)
      warnings.push(`${ctx.total_positions} open positions exceeds recommended maximum of 12`);
    if (ctx.drawdown_pct >= 10)
      warnings.push(`Portfolio in ${ctx.drawdown_pct.toFixed(1)}% drawdown — be cautious with new entries`);

    // Persist snapshot async
    persistExposureSnapshot(user.id, ctx).catch(() => {});

    return NextResponse.json({
      sector_exposure:   ctx.sector_exposure_pct,
      strategy_exposure: ctx.strategy_counts,
      total_positions:   ctx.total_positions,
      drawdown_pct:      ctx.drawdown_pct,
      capital_at_risk:   ctx.capital_at_risk_pct,
      largest_sector:    ctx.largest_sector_pct,
      warnings,
    });
  }

  // ── Full intelligence view ────────────────────────────────────
  if (view === 'intelligence') {
    const [ctxResult, posResult, scenario] = await Promise.allSettled([
      getPortfolioContext(user.id),
      db.query(
        `SELECT pp.tradingsymbol, pp.quantity, pp.buy_price, pp.current_price,
                COALESCE(i.sector,'Other') AS sector
         FROM portfolio_positions pp
         JOIN portfolios p ON p.id=pp.portfolio_id
         LEFT JOIN instruments i ON pp.instrument_id = i.id
         WHERE p.user_id=? AND pp.quantity>0`,
        [user.id]
      ),
      computeScenario(),
    ]);

    const ctx       = ctxResult.status === 'fulfilled'   ? ctxResult.value   : null;
    const positions = posResult.status === 'fulfilled'   ? posResult.value.rows as any[] : [];
    const scen      = scenario.status === 'fulfilled'    ? scenario.value    : null;
    const stance    = scen ? await computeMarketStance(scen).catch(() => null) : null;

    const enriched   = await enrichWithLivePrices(positions);
    const totalValue = enriched.reduce((s,p) => s + (p.quantity||0)*(p.current_price||p.buy_price||0), 0);
    const totalCost  = enriched.reduce((s,p) => s + (p.quantity||0)*(p.buy_price||0), 0);

    const regime   = await cacheGet<{regime:string}>('market:regime').catch(() => null);

    const posture  = stance?.guidance_message ?? (
      !regime?.regime ? 'Market regime unknown — maintain balanced positions' :
      regime.regime === 'STRONG_BULL' ? 'Aggressive — add to leaders on dips' :
      regime.regime === 'BULL'        ? 'Constructive — maintain longs, manage stops' :
      regime.regime === 'BEAR'        ? 'Cautious — tighten stops, no new longs' :
      regime.regime === 'STRONG_BEAR' ? 'Capital preservation — exit weak positions' :
      'Balanced — selective entries only'
    );

    // Exposure warnings
    const warnings: string[] = [];
    if (ctx) {
      for (const [s, pct] of Object.entries(ctx.sector_exposure_pct)) {
        if (pct >= 30) warnings.push(`${s} overexposed at ${pct}%`);
      }
      if (ctx.drawdown_pct >= 10) warnings.push(`${ctx.drawdown_pct.toFixed(1)}% drawdown — reduce risk`);
      if (ctx.total_positions >= 12) warnings.push('At maximum position count (12)');
    }

    return NextResponse.json({
      regime:          regime?.regime ?? 'NEUTRAL',
      market_stance:   stance?.market_stance ?? 'selective',
      posture,
      scenario_tag:    scen?.scenario_tag ?? null,
      positions:       enriched.length,
      total_value:     parseFloat(totalValue.toFixed(2)),
      total_pnl:       parseFloat((totalValue-totalCost).toFixed(2)),
      pnl_pct:         totalCost>0 ? parseFloat(((totalValue-totalCost)/totalCost*100).toFixed(2)) : 0,
      sector_exposure: ctx?.sector_exposure_pct ?? {},
      capital_at_risk: ctx?.capital_at_risk_pct ?? 0,
      drawdown_pct:    ctx?.drawdown_pct ?? 0,
      warnings,
      stance_config:   stance?.stance_config ?? null,
    });
  }

  return NextResponse.json({ error: 'Unknown view' }, { status: 400 });
}

// ── POST — add position ────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  try {
    const { tradingsymbol, exchange, instrument_key, quantity, buy_price } = await req.json();
    if (!tradingsymbol || !quantity || !buy_price)
      return NextResponse.json({ error: 'tradingsymbol, quantity, buy_price required' }, { status: 400 });

    const portfolioId = await getOrCreatePortfolio(user.id);
    if (!portfolioId) {
      console.error('[PORTFOLIO] ❌ refusing INSERT — portfolioId resolved to 0');
      return NextResponse.json({ error: 'Portfolio resolution failed' }, { status: 500 });
    }

    // Resolve canonical instrument_id at the boundary
    const instRef = await resolveByTicker(tradingsymbol.toUpperCase());
    const resolvedInstrumentId = instRef?.instrumentId ?? null;

    const r = await db.query(
      `INSERT INTO portfolio_positions
         (portfolio_id, instrument_id, instrument_key, tradingsymbol, exchange, quantity, buy_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [portfolioId, resolvedInstrumentId, instrument_key||null, tradingsymbol.toUpperCase(), exchange||'NSE', parseInt(quantity), parseFloat(buy_price)]
    );
    console.log(
      `[PORTFOLIO] INSERT portfolio_positions ` +
      `portfolioId=${portfolioId} symbol=${tradingsymbol.toUpperCase()} ` +
      `qty=${quantity} buy=${buy_price} insertId=${r.insertId ?? 'undefined'}`
    );
    console.log('OK OK ✅ API SUCCESS  /api/portfolio  POST');
    return NextResponse.json({ success: true, position_id: r.insertId ?? null }, { status: 201 });
  } catch (e: any) {
    console.error('[PORTFOLIO] POST failed:', e?.message ?? e);
    if (e.status===401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}

// ── PATCH — update position ────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  try {
    const { id, quantity, buy_price, current_price } = await req.json();
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.query(
      `UPDATE portfolio_positions pp JOIN portfolios p ON p.id=pp.portfolio_id
       SET pp.quantity=?, pp.buy_price=?, pp.current_price=?, pp.updated_at=NOW()
       WHERE pp.id=? AND p.user_id=?`,
      [quantity, buy_price, current_price||null, id, user.id]
    );
    return NextResponse.json({ success: true });
  } catch { return NextResponse.json({ error: 'Server error' }, { status: 500 }); }
}

// ── DELETE — remove position ───────────────────────────────────────
export async function DELETE(req: NextRequest) {
  let user: any;
  try { user = await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  try {
    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await db.query(
      `DELETE pp FROM portfolio_positions pp
       JOIN portfolios p ON p.id=pp.portfolio_id
       WHERE pp.id=? AND p.user_id=?`,
      [id, user.id]
    );
    return NextResponse.json({ success: true });
  } catch { return NextResponse.json({ error: 'Server error' }, { status: 500 }); }
}
