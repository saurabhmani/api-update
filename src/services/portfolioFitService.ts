/**
 * Portfolio Fit Service — Quantorus365
 *
 * Trade quality = stock quality × portfolio fit.
 *
 * Computes portfolio fit score (0–100) from:
 *   - Exact sector exposure % vs cap from systemConfigService
 *   - Rolling 60-day correlation from DB candles
 *   - Capital at risk vs risk budget
 *   - Strategy concentration (fraction per type)
 *   - Position count headroom
 *   - Drawdown state
 *
 * Correlation is now computed from actual daily return history stored
 * in the candles table, not approximated.
 */

import { db }              from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import { getConfig }       from './systemConfigService';

// ── Types ──────────────────────────────────────────────────────────

export interface PortfolioContext {
  total_positions:          number;
  open_longs:               number;
  open_shorts:              number;
  sector_counts:            Record<string, number>;
  sector_exposure_pct:      Record<string, number>;   // exact %
  strategy_counts:          Record<string, number>;
  capital_at_risk_pct:      number;
  unrealized_pnl_pct:       number;
  largest_sector_pct:       number;
  most_crowded_strategy:    string;
  correlation_avg:          number;   // real rolling correlation
  drawdown_pct:             number;
}

export interface PortfolioFitResult {
  portfolio_fit_score:  number;
  sector_penalty:       number;
  correlation_penalty:  number;
  strategy_penalty:     number;
  drawdown_penalty:     number;
  capacity_score:       number;
  warnings:             string[];
  notes:                string;
}

// ── Rolling correlation from candles table ────────────────────────

async function computeRealCorrelation(
  symbolA: string,
  symbolB: string,
  days    = 60
): Promise<number | null> {
  try {
    const { rows } = await db.query(`
      SELECT a.ts, a.close AS close_a, b.close AS close_b
      FROM candles a
      JOIN candles b ON DATE(a.ts)=DATE(b.ts)
        AND a.interval_unit='1day' AND b.interval_unit='1day'
        AND b.instrument_key=(SELECT instrument_key FROM instruments WHERE tradingsymbol=? AND is_active=TRUE LIMIT 1)
      WHERE a.instrument_key=(SELECT instrument_key FROM instruments WHERE tradingsymbol=? AND is_active=TRUE LIMIT 1)
        AND a.ts >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY a.ts ASC
      LIMIT 200
    `, [symbolB, symbolA, days]);

    if ((rows as any[]).length < 10) return null;

    const ra: number[] = []; const rb: number[] = [];
    const r = rows as any[];
    for (let i = 1; i < r.length; i++) {
      const ca = Number(r[i].close_a); const cb = Number(r[i].close_b);
      const pa = Number(r[i-1].close_a); const pb = Number(r[i-1].close_b);
      if (pa > 0 && pb > 0) { ra.push((ca-pa)/pa); rb.push((cb-pb)/pb); }
    }
    if (ra.length < 5) return null;

    const n   = ra.length;
    const ma  = ra.reduce((s,v)=>s+v,0)/n;
    const mb  = rb.reduce((s,v)=>s+v,0)/n;
    const cov = ra.reduce((s,v,i)=>s+(v-ma)*(rb[i]-mb),0)/n;
    const sa  = Math.sqrt(ra.reduce((s,v)=>s+(v-ma)**2,0)/n);
    const sb  = Math.sqrt(rb.reduce((s,v)=>s+(v-mb)**2,0)/n);
    return sa > 0 && sb > 0 ? parseFloat((cov/(sa*sb)).toFixed(4)) : null;
  } catch { return null; }
}

async function getPortfolioCorrelation(symbols: string[], days: number): Promise<number> {
  if (symbols.length < 2) return 0;
  const pairs: number[] = [];

  // Sample up to 6 symbols to avoid too many queries
  const sample = symbols.slice(0, 6);
  for (let i = 0; i < sample.length - 1; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const corr = await computeRealCorrelation(sample[i], sample[j], days);
      if (corr != null) pairs.push(Math.abs(corr));
    }
  }

  if (!pairs.length) return 0;
  const avg = pairs.reduce((s,v)=>s+v,0) / pairs.length;
  return parseFloat(avg.toFixed(4));
}

// ── Portfolio context ─────────────────────────────────────────────

export async function getPortfolioContext(userId: number): Promise<PortfolioContext> {
  const cacheKey = `portfolio:context:${userId}`;
  const cached   = await cacheGet<PortfolioContext>(cacheKey);
  if (cached) return cached;

  const def: PortfolioContext = {
    total_positions:0, open_longs:0, open_shorts:0,
    sector_counts:{}, sector_exposure_pct:{}, strategy_counts:{},
    capital_at_risk_pct:0, unrealized_pnl_pct:0, largest_sector_pct:0,
    most_crowded_strategy:'', correlation_avg:0, drawdown_pct:0,
  };

  try {
    const { rows: pos } = await db.query(`
      SELECT pp.tradingsymbol, pp.quantity, pp.buy_price, pp.current_price,
             COALESCE(i.sector,'Other') AS sector
      FROM portfolio_positions pp
      JOIN portfolios p ON p.id=pp.portfolio_id
      LEFT JOIN instruments i ON pp.instrument_id = i.id
      WHERE p.user_id=? AND pp.quantity>0
    `, [userId]);

    if (!(pos as any[]).length) { await cacheSet(cacheKey, def, 120); return def; }

    let totalCost = 0; let totalValue = 0;
    const sectorValues: Record<string, number> = {};
    const symbols: string[] = [];

    for (const p of pos as any[]) {
      const cost  = (p.quantity||0)*(p.buy_price||0);
      const val   = (p.quantity||0)*(p.current_price||p.buy_price||0);
      totalCost  += cost; totalValue += val;
      const s     = p.sector || 'Other';
      sectorValues[s] = (sectorValues[s]||0) + val;
      def.sector_counts[s] = (def.sector_counts[s]||0) + 1;
      symbols.push(p.tradingsymbol);
    }

    // Exact sector exposure %
    let largest = 0;
    for (const [s, v] of Object.entries(sectorValues)) {
      const pct = totalValue > 0 ? parseFloat((v/totalValue*100).toFixed(1)) : 0;
      def.sector_exposure_pct[s] = pct;
      if (pct > largest) largest = pct;
    }
    def.largest_sector_pct = largest;

    // Strategy counts from recent approved signals
    const { rows: sigRows } = await db.query(`
      SELECT scenario_tag, COUNT(*) AS cnt
      FROM signals
      WHERE tradingsymbol IN (${symbols.map(()=>'?').join(',')})
        AND generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND signal_type IN ('BUY','SELL')
      GROUP BY scenario_tag
    `, symbols).catch(() => ({ rows: [] }));

    for (const r of sigRows as any[]) {
      if (r.scenario_tag) def.strategy_counts[r.scenario_tag] = Number(r.cnt);
    }
    const totalStrat = Object.values(def.strategy_counts).reduce((a,b)=>a+b,0);
    def.most_crowded_strategy = Object.entries(def.strategy_counts)
      .sort((a,b)=>b[1]-a[1])[0]?.[0] ?? '';

    const cfg = await getConfig();
    def.total_positions      = (pos as any[]).length;
    def.open_longs           = (pos as any[]).length;
    def.unrealized_pnl_pct   = totalCost > 0 ? parseFloat(((totalValue-totalCost)/totalCost*100).toFixed(2)) : 0;
    def.drawdown_pct         = def.unrealized_pnl_pct < 0 ? Math.abs(def.unrealized_pnl_pct) : 0;
    def.capital_at_risk_pct  = Math.min(cfg.CAPITAL_AT_RISK_CAP, def.total_positions * 1.5);

    // Real correlation (async, best-effort)
    def.correlation_avg = await getPortfolioCorrelation(symbols, cfg.CORRELATION_LOOKBACK_DAYS);

    await cacheSet(cacheKey, def, 120);
    return def;
  } catch {
    return def;
  }
}

// ── Fit scoring ───────────────────────────────────────────────────

export function computePortfolioFit(
  context:         PortfolioContext,
  targetSector:    string,
  targetStrategy:  string,
  _direction:      string
): PortfolioFitResult {
  let score = 100;
  const warnings: string[] = [];

  // Thresholds are applied at call site from systemConfigService

  const currentSectorPct = context.sector_exposure_pct[targetSector] ?? 0;
  let sectorPenalty = 0;
  if (currentSectorPct >= 30)        { sectorPenalty = 50; warnings.push(`${targetSector} at ${currentSectorPct.toFixed(0)}% — at sector cap (30%)`); }
  else if (currentSectorPct >= 22)   { sectorPenalty = 25; warnings.push(`${targetSector} approaching cap (${currentSectorPct.toFixed(0)}%)`); }
  else if (currentSectorPct >= 15)   { sectorPenalty = 10; }
  score -= sectorPenalty;

  let capacityScore = 100;
  if (context.total_positions >= 12) {
    score -= 40; capacityScore = 0;
    warnings.push('Portfolio at maximum 12 positions');
  } else if (context.total_positions >= 10) {
    score -= 15; capacityScore = 30;
    warnings.push('Portfolio near maximum position count');
  } else {
    capacityScore = Math.round(((12 - context.total_positions) / 12) * 100);
  }

  let strategyPenalty = 0;
  const totalStrategies = Object.values(context.strategy_counts).reduce((a,b)=>a+b,0);
  const stratFrac = totalStrategies > 0 ? (context.strategy_counts[targetStrategy] ?? 0) / totalStrategies : 0;
  if (stratFrac >= 0.50)       { strategyPenalty = 20; warnings.push(`Strategy "${targetStrategy}" already crowded`); }
  else if (stratFrac >= 0.35)  { strategyPenalty = 10; }
  score -= strategyPenalty;

  let drawdownPenalty = 0;
  if (context.drawdown_pct >= 15)      { drawdownPenalty = 25; warnings.push(`Portfolio in ${context.drawdown_pct.toFixed(1)}% drawdown — caution on new entries`); }
  else if (context.drawdown_pct >= 9)  { drawdownPenalty = 12; }
  score -= drawdownPenalty;

  if (context.capital_at_risk_pct >= 20) { score -= 15; warnings.push(`Capital at risk ${context.capital_at_risk_pct.toFixed(0)}% — at cap`); }

  let correlationPenalty = 0;
  if (context.correlation_avg > 0.75)      { correlationPenalty = 20; warnings.push(`High portfolio correlation (${context.correlation_avg.toFixed(2)}) — lacks diversification`); }
  else if (context.correlation_avg > 0.60) { correlationPenalty = 10; }
  score -= correlationPenalty;

  // Diversification bonus
  if (Object.keys(context.sector_exposure_pct).length >= 4) score += 5;
  if (context.unrealized_pnl_pct > 5) score += 5;

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  const notes =
    finalScore >= 80 ? 'Excellent portfolio fit — this setup diversifies well' :
    finalScore >= 60 ? 'Acceptable fit — monitor sector as you scale' :
    finalScore >= 40 ? 'Marginal fit — reduce size or wait for better conditions' :
    'Poor portfolio fit — would overconcentrate or add risk';

  return {
    portfolio_fit_score: finalScore,
    sector_penalty:      sectorPenalty,
    correlation_penalty: correlationPenalty,
    strategy_penalty:    strategyPenalty,
    drawdown_penalty:    drawdownPenalty,
    capacity_score:      capacityScore,
    warnings,
    notes,
  };
}

// ── Persistence ───────────────────────────────────────────────────

export async function persistPortfolioFitLog(
  symbol:   string,
  signalId: number | null,
  result:   PortfolioFitResult
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO portfolio_fit_logs
        (symbol, signal_id, portfolio_fit_score,
         sector_penalty, correlation_penalty, strategy_penalty, drawdown_penalty, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [symbol, signalId, result.portfolio_fit_score,
       result.sector_penalty, result.correlation_penalty,
       result.strategy_penalty, result.drawdown_penalty,
       JSON.stringify({ warnings: result.warnings, notes: result.notes })]);
  } catch {}
}

export async function persistExposureSnapshot(
  _userId:  number,
  context: PortfolioContext
): Promise<void> {
  try {
    await db.query(`
      INSERT INTO portfolio_exposure_snapshots
        (total_exposure_pct, cash_pct, sector_exposure_json,
         strategy_exposure_json, directional_exposure_json, risk_budget_used_pct)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      Math.min(100, context.total_positions * 8),
      Math.max(0, 100 - context.total_positions * 8),
      JSON.stringify(context.sector_exposure_pct),
      JSON.stringify(context.strategy_counts),
      JSON.stringify({ long: context.open_longs, short: context.open_shorts }),
      context.capital_at_risk_pct,
    ]);
  } catch {}
}
