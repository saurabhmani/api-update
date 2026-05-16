

/**
 * Market Intelligence Service
 *
 * Computes market-wide intelligence purely from cached data.
 * RULE: Zero direct external API calls inside this file.
 *       All data comes from Redis → MySQL fallback only.
 *
 * Legacy cache keys consumed (still populated by the scheduler):
 *   stock:{SYMBOL}            — MarketSnapshot per symbol (written by scheduler)
 *   nse:/allIndices           — Raw index array (legacy key, populated by scheduler)
 *   nse:/fiidiiTradeReact     — FII/DII raw array (legacy key, populated by scheduler)
 *   nse:/live-analysis-variations?index=NIFTY 500 — gainers/losers (legacy key)
 *   market:explanation        — MarketExplanation object (written by marketExplanation.ts)
 *
 * MySQL fallback queries (only when Redis is cold):
 *   rankings  — for gainers/losers/trend when no Redis snapshots exist
 *   macro_data — for FII/DII when the live cache is absent
 *   candles   — for volatility calculation
 */

import { cacheGet, cacheSet }                          from '@/lib/redis';
import { db }                                           from '@/lib/db';
import { fetchIndices, fetchFiiDii, fetchGainersLosers } from './marketQuote';
import type { MarketSnapshot }                         from './marketDataService';
import { getTickStore }                                 from '@/lib/marketData/tickStore';
import type { TickData }                                from '@/lib/marketData/tickTypes';
import { detectEnhancedRegime }                         from '@/lib/signal-engine/regime/detectMarketRegime';
import type { Candle }                                  from '@/lib/signal-engine/types/signalEngine.types';
import { fetchUnifiedMarketData }                       from './unifiedMarketData';

// ── Output types ─────────────────────────────────────────────────

export type MarketTrend = 'Strong Bull' | 'Bull' | 'Neutral' | 'Bear' | 'Strong Bear';

export interface SectorStrength {
  sector:         string;
  change_percent: number;
  trend:          'up' | 'down' | 'flat';
}

export interface MoverEntry {
  symbol:         string;
  name:           string;
  ltp:            number;
  change_percent: number;
  change_abs:     number;
  volume:         number;
}

export interface FiiDiiEntry {
  date:       string;
  fii_buy:    number;
  fii_sell:   number;
  fii_net:    number;
  dii_buy:    number;
  dii_sell:   number;
  dii_net:    number;
  fii_label:  string;  // human-readable
  dii_label:  string;
}

export interface VolatilityMetrics {
  nifty_vix:        number | null;
  avg_range_pct:    number;          // avg (high-low)/close across universe
  high_vol_count:   number;          // symbols with range > 3%
  low_vol_count:    number;          // symbols with range < 1%
  volatility_label: 'Very High' | 'High' | 'Normal' | 'Low';
}

export interface MarketIntelligenceResult {
  market_trend:    MarketTrend;
  trend_score:     number;           // -100 to +100
  advancing:       number;           // count of stocks up
  declining:       number;           // count of stocks down
  unchanged:       number;
  sector_strength: SectorStrength[];
  top_gainers:     MoverEntry[];
  top_losers:      MoverEntry[];
  fii_dii:         FiiDiiEntry[];
  volatility:      VolatilityMetrics;
  as_of:           string;           // ISO timestamp of most recent data
  data_source:     'redis' | 'mysql' | 'mixed';
  cache_age_sec:   number | null;    // how old the underlying stock data is
  // Authoritative composite regime label from classifyCompositeRegime —
  // blends engine EMA, breadth, VIX, sectors, and flow with a hard
  // rejection rule. This is the single value every UI surface should
  // prefer over the raw market_trend.
  regime_label:       string | null;
  regime_confidence:  number;
  regime_reason:      string;
  // True when the composite classifier demoted a bull label or
  // confidence < 60 — tells the UI to render a "signals less
  // reliable" banner and the stance engine to tighten thresholds.
  weak_market:        boolean;
}

// ── Output cache ─────────────────────────────────────────────────
const INTEL_CACHE_KEY = 'market:intelligence';
// Shortened from 60s so the dashboard's 10s poll actually sees
// movement. Raise again if you reintroduce a scheduler that
// writes this key on a slower cadence.
const INTEL_CACHE_TTL = 8; // seconds

// In-process memory cache — ensures scenario engine can read the result
// even when Redis is disabled (REDIS_DISABLED=1).
let _memCache: MarketIntelligenceResult | null = null;
let _memCacheAt = 0;
const MEM_CACHE_TTL_MS = 8_000;

// ── Sector index → Redis key mapping ─────────────────────────────
// Legacy Redis keys — still populated by the scheduler for backward
// compatibility; the strings themselves are protected tokens.
const INDICES_CACHE_KEY = 'nse:/allIndices';
const FIIDII_CACHE_KEY  = 'nse:/fiidiiTradeReact';
const GAINERS_CACHE_KEY = 'nse:/equity-stockIndices?index=NIFTY%20500';

const SECTOR_INDEX_NAMES: Record<string, string> = {
  'NIFTY BANK':        'Banking',
  'NIFTY IT':          'IT',
  'NIFTY PHARMA':      'Pharma',
  'NIFTY AUTO':        'Auto',
  'NIFTY FMCG':        'FMCG',
  'NIFTY REALTY':      'Realty',
  'NIFTY METAL':       'Metal',
  'NIFTY ENERGY':      'Energy',
  'NIFTY MIDCAP 100':  'Midcap',
  'NIFTY SMALLCAP 100':'Smallcap',
};

// ── Helpers ───────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function trendFromScore(score: number): MarketTrend {
  if (score >= 50)  return 'Strong Bull';
  if (score >= 15)  return 'Bull';
  if (score <= -50) return 'Strong Bear';
  if (score <= -15) return 'Bear';
  return 'Neutral';
}

// Map the signal engine's NIFTY-50 EMA/RSI regime label onto the
// same 5-bucket MarketTrend enum the dashboard renders. Keeping the
// mapping in one place means a new regime label (e.g. "Weak") has
// exactly one translation for the UI.
function trendFromRegimeLabel(label: string): MarketTrend | null {
  switch (label) {
    case 'Strong Bullish':        return 'Strong Bull';
    case 'Bullish':               return 'Bull';
    case 'Bearish':               return 'Bear';
    case 'Weak':                  return 'Bear';
    case 'High Volatility Risk':  return 'Neutral';
    case 'Sideways':              return 'Neutral';
    default:                      return null;
  }
}

// ════════════════════════════════════════════════════════════════
// Composite Regime Classifier
//
// Blends structural (EMA engine) + live breadth + VIX + sectors +
// institutional flow into a single verdict. The design rule: no
// single signal can produce a bullish label on its own. A "Strong
// Bull" label requires the engine AND breadth AND VIX AND sectors
// to all agree; any one of them flipping bearish demotes the
// label. This is what prevents the "Strong Bull while NIFTY is
// at 22,000 and breadth is -4" failure mode.
// ════════════════════════════════════════════════════════════════
interface CompositeRegimeInput {
  trendScore:     number;   // -100..+100 breadth-weighted score
  advPct:         number;   // % advancing
  decPct:         number;   // % declining
  vix:            number;   // India VIX
  redSectorPct:   number;   // % of tracked sectors trading red
  fiiNet:         number;   // today's FII net in Cr
  engineRegime:   string | null;   // EMA/RSI label from detectEnhancedRegime
  engineStrength: number | null;   // 0..100 alignment score
}

interface CompositeRegimeOutput {
  regime:     MarketTrend;
  confidence: number;
  reason:     string;
}

function classifyCompositeRegime(i: CompositeRegimeInput): CompositeRegimeOutput {
  const reasons: string[] = [];
  let label: MarketTrend = 'Neutral';
  let confidence = 50;

  const engineStrong    = i.engineRegime === 'Strong Bullish';
  const engineBullish   = i.engineRegime === 'Bullish' || engineStrong;
  const engineBearish   = i.engineRegime === 'Bearish' || i.engineRegime === 'Weak';

  // ── Strong Bull: every signal must confirm ───────────────────
  if (
    engineStrong &&
    i.advPct     >= 65 &&
    i.trendScore >= 50 &&
    i.vix        <  18 &&
    i.redSectorPct < 30 &&
    i.fiiNet     >  0
  ) {
    label = 'Strong Bull';
    confidence = 85 + Math.min(10, (i.engineStrength ?? 0) / 10);
    reasons.push('engine Strong Bullish', 'breadth>65%', 'VIX<18', 'sectors green', 'FII buying');
  }
  // ── Bull: healthy breadth + positive score, VIX contained ────
  else if (
    engineBullish &&
    i.advPct     >= 55 &&
    i.trendScore >= 20 &&
    i.vix        <  22
  ) {
    label = 'Bull';
    confidence = 70;
    reasons.push('engine bullish', 'breadth>55%', 'trendScore>20');
  }
  // ── Strong Bear ──────────────────────────────────────────────
  else if (
    i.decPct     >  70 &&
    i.vix        >  22 &&
    i.redSectorPct > 60 &&
    i.fiiNet     <  -1000
  ) {
    label = 'Strong Bear';
    confidence = 85;
    reasons.push('declining>70%', 'VIX>22', 'sectors red', 'FII heavy selling');
  }
  // ── Bear ─────────────────────────────────────────────────────
  else if (
    i.decPct     >  55 &&
    i.trendScore <  -20 &&
    i.vix        >  18
  ) {
    label = 'Bear';
    confidence = 70;
    reasons.push('declining>55%', 'trendScore<-20', 'VIX rising');
  }
  // ── Neutral — weak mixed conditions ──────────────────────────
  else {
    label = 'Neutral';
    confidence = 52;
    if (Math.abs(i.trendScore) < 20) reasons.push('trendScore flat');
    if (i.advPct > 45 && i.advPct < 55) reasons.push('breadth ~50%');
    if (i.redSectorPct > 40 && i.redSectorPct < 60) reasons.push('sectors mixed');
    if (reasons.length === 0) reasons.push('no clear trend');
  }

  // ── HARD REJECTION RULE ──────────────────────────────────────
  // No matter what the engine or any individual signal says, the
  // system must never label the tape "Strong Bull" / "Bull" when
  // breadth is collapsing, VIX is elevated, or sectors are red.
  // This is the guardrail that prevents stale NIFTY candles from
  // producing a Strong Bull label during an obvious selloff.
  const hardReject =
    i.advPct < 30 ||
    i.vix    > 20 ||
    i.redSectorPct > 60;

  if (hardReject && (label === 'Strong Bull' || label === 'Bull')) {
    const overrides: string[] = [];
    if (i.advPct < 30)      overrides.push(`advancing only ${i.advPct.toFixed(0)}%`);
    if (i.vix    > 20)      overrides.push(`VIX ${i.vix.toFixed(1)} > 20`);
    if (i.redSectorPct > 60)overrides.push(`${i.redSectorPct.toFixed(0)}% sectors red`);
    const demoted: MarketTrend =
      i.trendScore < -20 || i.decPct > 55 ? 'Bear' : 'Neutral';
    console.warn(
      `[REGIME OVERRIDE] ${label} → ${demoted}  (${overrides.join(', ')})`
    );
    label = demoted;
    confidence = Math.min(confidence, 55);
    reasons.unshift(`HARD REJECT: ${overrides.join(' + ')}`);
  }

  // Engine disagreement dampener — if the engine says bull but the
  // composite landed on Neutral/Bear, cap confidence so downstream
  // consumers treat the result as tentative.
  if ((engineBullish && label !== 'Strong Bull' && label !== 'Bull') ||
      (engineBearish && label !== 'Strong Bear' && label !== 'Bear')) {
    confidence = Math.min(confidence, 55);
    reasons.push(`engine=${i.engineRegime} disagrees`);
  }

  return {
    regime: label,
    confidence: Math.round(confidence),
    reason: reasons.join(' · '),
  };
}

// Pull the NIFTY 50 benchmark candles from market_data_daily — the
// SAME table and the SAME ordering the signal engine's
// dbCandleProvider uses. This guarantees the regime the dashboard
// shows is computed from exactly the same input the pipeline log
// prints. Returns [] if the table is empty (triggers fallback to
// trendFromScore downstream).
async function fetchBenchmarkCandles(): Promise<Candle[]> {
  try {
    // NEWEST 300 bars, re-sorted ASC. Without the DESC+subquery trick
    // we'd silently be running trend math on 2025 data once NIFTY 50
    // has accumulated >300 daily bars.
    const result = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT 300
       ) t
       ORDER BY ts ASC`,
      ['NIFTY 50'],
    );
    return result.rows.map((r: any) => ({
      ts:     r.ts,
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume ?? 0),
    }));
  } catch {
    return [];
  }
}

// ── Build a MarketSnapshot from a live Kite WebSocket tick ────── // @deprecated marker
// The tickStore is fed by the same WebSocket that drives /signals
// and /stocks — so every symbol with an active subscription has a
// sub-second-old tick available here with zero REST traffic.
// This is the "live fast path" that replaces the stale stock:*
// Redis snapshots whenever a fresher tick is available.
function snapshotFromTick(sym: string, t: TickData): MarketSnapshot {
  // Fallback ladder for percent change:
  //   1. Kite-provided pChange (available in quote/full mode) // @deprecated marker
  //   2. Previous session close (`t.close` in Kite's wire format) // @deprecated marker
  //   3. Today's open (intraday move — what you see on the exchange site
  //      when the previous close hasn't been stitched in yet)
  const prevClose = t.close && t.close > 0 ? t.close : 0;
  let changePct: number;
  if (typeof t.pChange === 'number' && Number.isFinite(t.pChange) && t.pChange !== 0) {
    changePct = t.pChange;
  } else if (prevClose > 0) {
    changePct = ((t.lastPrice - prevClose) / prevClose) * 100;
  } else if (t.open && t.open > 0) {
    changePct = ((t.lastPrice - t.open) / t.open) * 100;
  } else {
    changePct = 0;
  }
  const basis = prevClose > 0 ? prevClose : (t.open && t.open > 0 ? t.open : t.lastPrice);
  const changeAbs = typeof t.change === 'number' && Number.isFinite(t.change)
    ? t.change
    : t.lastPrice - basis;

  return {
    symbol:         sym,
    instrument_key: `NSE_EQ|${sym}`,
    ltp:            t.lastPrice,
    open:           t.open   ?? t.lastPrice,
    high:           t.high   ?? t.lastPrice,
    low:            t.low    ?? t.lastPrice,
    close:          basis,
    volume:         t.volume ?? 0,
    oi:             0,
    change_percent: changePct,
    change_abs:     changeAbs,
    vwap:           null,
    week52_high:    0,
    week52_low:     0,
    atr14:          null,
    delivery_pct:   null,
    timestamp:      t.ts ?? Date.now(),
    source:         'cache',
    data_quality:   0.95, // live WS tick — highest tier short of direct exchange feed
  };
}

// ── Layer 1: Read snapshots — live tickStore first, Redis fallback.
// Priority:
//   1. In-process tickStore   — populated by Kite WebSocket. Fastest, // @deprecated marker
//      freshest, no network hops.
//   2. Redis stock:{SYM} key  — written by the scheduler worker.
//   3. Missing                — caller will fall back to MySQL/live feed.
async function readStockSnapshotsFromRedis(
  symbols: string[]
): Promise<{ snaps: MarketSnapshot[]; hitCount: number }> {
  const snaps: MarketSnapshot[] = [];
  let hitCount = 0;
  let liveCount = 0;

  const tickStore = getTickStore();
  try { tickStore.install(); } catch { /* idempotent */ }
  const STALE_CUTOFF_MS = 5 * 60_000; // 5 minutes
  const now = Date.now();

  await Promise.all(symbols.map(async sym => {
    const upper = sym.toUpperCase();

    // 1. Live tick from WebSocket (sub-second freshness)
    const liveTick = tickStore.get(upper);
    if (liveTick && liveTick.lastPrice > 0) {
      snaps.push(snapshotFromTick(upper, liveTick));
      liveCount++;
      hitCount++;
      return;
    }

    // 2. Redis scheduler snapshot — only if fresh. Anything older
    //    than 5 min would poison the breadth computation with
    //    frozen change_percent values from yesterday.
    const snap = await cacheGet<MarketSnapshot>(`stock:${upper}`);
    if (snap && snap.timestamp && now - snap.timestamp < STALE_CUTOFF_MS) {
      snaps.push(snap);
      hitCount++;
    }
  }));

  console.log(`[MarketIntel] snapshot read  universe=${symbols.length} live=${liveCount} redis=${hitCount - liveCount} dropped=${symbols.length - hitCount}`);
  return { snaps, hitCount };
}

// ── Layer 2: MySQL fallback for movers ───────────────────────────

async function getMoversMysql(
  type: 'gainers' | 'losers',
  limit = 10
): Promise<MoverEntry[]> {
  try {
    // Sign filter is the load-bearing fix here. Previously the SQL only
    // did `ORDER BY pct_change ASC LIMIT 10` for losers — when a closed
    // / strongly-bullish day left the rankings table with no negative
    // pct_change rows, this returned the 10 SMALLEST POSITIVE values
    // mislabeled as losers. The dashboard's `change_percent < 0` filter
    // then rejected all of them and rendered "Last close losers
    // unavailable" even though /api/rankings clearly had positives and
    // negatives for the user to see on the rankings page.
    //
    // After the fix:
    //   • losers  → only rows where pct_change < 0
    //   • gainers → only rows where pct_change > 0
    // If the DB genuinely has no negatives, this returns [] (honest empty)
    // and the dashboard can fall back to its own rankings-derived list
    // built from a wider candidate pool.
    const order      = type === 'gainers' ? 'DESC' : 'ASC';
    const signFilter = type === 'gainers' ? 'AND r.pct_change > 0' : 'AND r.pct_change < 0';
    const { rows } = await db.query(`
      SELECT r.tradingsymbol AS symbol,
             COALESCE(r.name, r.tradingsymbol) AS name,
             COALESCE(r.ltp, 0)        AS ltp,
             COALESCE(r.pct_change, 0) AS change_percent,
             0                          AS change_abs,
             COALESCE(r.volume, 0)     AS volume
      FROM rankings r
      INNER JOIN (
        SELECT tradingsymbol, MAX(score) AS max_score
        FROM rankings
        GROUP BY tradingsymbol
      ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
      WHERE r.pct_change IS NOT NULL
        ${signFilter}
      GROUP BY r.tradingsymbol
      ORDER BY r.pct_change ${order}
      LIMIT ?
    `, [limit]);

    const mapped = (rows as any[]).map(r => ({
      symbol:         String(r.symbol || ''),
      name:           String(r.name   || r.symbol || ''),
      // toNum handles MySQL DECIMAL → string-coming-back-from-mysql2
      // (decimalNumbers defaults to false in some driver versions),
      // so we never propagate a string into the JSON envelope.
      ltp:            toNum(r.ltp),
      change_percent: toNum(r.change_percent),
      change_abs:     toNum(r.change_abs),
      volume:         toNum(r.volume),
    }));

    // Defensive sign re-check post-coercion — if the DB returns 0.0000
    // for a row that the WHERE clause matched (rare, but possible with
    // floating-point edge cases), drop it so the dashboard's sign
    // filter never sees a contradictory value.
    return mapped.filter(m =>
      type === 'gainers' ? m.change_percent > 0 : m.change_percent < 0
    );
  } catch (err: any) {
    console.warn(`[MarketIntel] getMoversMysql(${type}) failed:`, err?.message);
    return [];
  }
}

// ── Layer 2: MySQL fallback for trend score ───────────────────────

async function getTrendScoreMysql(): Promise<{
  score: number; advancing: number; declining: number; unchanged: number;
}> {
  try {
    const { rows } = await db.query(`
      SELECT
        SUM(CASE WHEN pct_change > 0 THEN 1 ELSE 0 END) AS advancing,
        SUM(CASE WHEN pct_change < 0 THEN 1 ELSE 0 END) AS declining,
        SUM(CASE WHEN pct_change = 0 OR pct_change IS NULL THEN 1 ELSE 0 END) AS unchanged,
        AVG(pct_change) AS avg_change
      FROM (
        SELECT r.tradingsymbol, r.pct_change
        FROM rankings r
        INNER JOIN (
          SELECT tradingsymbol, MAX(score) AS max_score
          FROM rankings
          GROUP BY tradingsymbol
        ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
        GROUP BY r.tradingsymbol
      ) deduped
    `);
    const row        = (rows as any[])[0] ?? {};
    const advancing  = toNum(row.advancing);
    const declining  = toNum(row.declining);
    const unchanged  = toNum(row.unchanged);
    const total      = advancing + declining + unchanged || 1;
    const breadthPct = ((advancing - declining) / total) * 100;
    const avgChg     = toNum(row.avg_change);
    const score      = Math.round((breadthPct * 0.7) + (avgChg * 0.3 * 10));
    return { score: Math.max(-100, Math.min(100, score)), advancing, declining, unchanged };
  } catch {
    return { score: 0, advancing: 0, declining: 0, unchanged: 0 };
  }
}

// ── Layer 2: MySQL fallback for volatility ───────────────────────

async function getVolatilityMysql(): Promise<VolatilityMetrics> {
  try {
    const { rows } = await db.query(`
      SELECT
        AVG((c.high - c.low) / NULLIF(c.close, 0) * 100) AS avg_range_pct,
        SUM(CASE WHEN (c.high - c.low) / NULLIF(c.close, 0) * 100 > 3 THEN 1 ELSE 0 END) AS high_vol,
        SUM(CASE WHEN (c.high - c.low) / NULLIF(c.close, 0) * 100 < 1 THEN 1 ELSE 0 END) AS low_vol
      FROM candles c
      INNER JOIN (
        SELECT instrument_key, MAX(ts) AS max_ts
        FROM candles
        WHERE candle_type = 'eod'
        GROUP BY instrument_key
      ) latest ON c.instrument_key = latest.instrument_key AND c.ts = latest.max_ts
      WHERE c.candle_type = 'eod'
        AND c.close > 0
    `);
    const row        = (rows as any[])[0] ?? {};
    const avgRange   = toNum(row.avg_range_pct, 2);
    const highVol    = toNum(row.high_vol);
    const lowVol     = toNum(row.low_vol);
    const label: VolatilityMetrics['volatility_label'] =
      avgRange > 4   ? 'Very High' :
      avgRange > 2.5 ? 'High' :
      avgRange > 1   ? 'Normal'    : 'Low';

    return { nifty_vix: null, avg_range_pct: avgRange, high_vol_count: highVol, low_vol_count: lowVol, volatility_label: label };
  } catch {
    return { nifty_vix: null, avg_range_pct: 0, high_vol_count: 0, low_vol_count: 0, volatility_label: 'Normal' };
  }
}

// ── FII/DII normaliser ────────────────────────────────────────────

// Upstream feed returns one row per category (FII/FPI, DII) per date.
// Group by date first, then combine FII and DII into a single entry per date.
function normaliseFiiDii(raw: any[]): FiiDiiEntry[] {
  if (!Array.isArray(raw) || !raw.length) return [];

  const byDate: Record<string, { fii_buy: number; fii_sell: number; fii_net: number; dii_buy: number; dii_sell: number; dii_net: number }> = {};

  for (const row of raw) {
    const date = String(row.date ?? row.tradeDate ?? row.Date ?? '');
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { fii_buy: 0, fii_sell: 0, fii_net: 0, dii_buy: 0, dii_sell: 0, dii_net: 0 };

    const cat  = String(row.category ?? row.clientType ?? '').toLowerCase();
    const buy  = toNum(row.buyValue  ?? row.buy  ?? row.purchaseValue  ?? row.grossPurchase ?? 0);
    const sell = toNum(row.sellValue ?? row.sell ?? row.salesValue     ?? row.grossSales    ?? 0);
    const net  = row.netValue != null ? toNum(row.netValue) : row.net != null ? toNum(row.net) : row.netPurchase != null ? toNum(row.netPurchase) : (buy - sell);

    if (cat.includes('fii') || cat.includes('fpi') || cat.includes('foreign')) {
      byDate[date].fii_buy  = buy;
      byDate[date].fii_sell = sell;
      byDate[date].fii_net  = net;
    } else if (cat.includes('dii') || cat.includes('domestic')) {
      byDate[date].dii_buy  = buy;
      byDate[date].dii_sell = sell;
      byDate[date].dii_net  = net;
    }
  }

  return Object.entries(byDate).slice(0, 5).map(([date, v]) => {
    // Auto-detect unit: the fiidiiTradeReact feed returns values in Crores.
    // If values are suspiciously large (>100000), they're likely in Lakhs
    // and need /100 conversion. Normal Cr values are 500–50000 range.
    const maxVal = Math.max(Math.abs(v.fii_buy), Math.abs(v.fii_sell), Math.abs(v.dii_buy), Math.abs(v.dii_sell));
    const divisor = maxVal > 100_000 ? 100 : 1;
    const fii_net = v.fii_net / divisor;
    const dii_net = v.dii_net / divisor;

    return {
      date,
      fii_buy:   v.fii_buy / divisor,
      fii_sell:  v.fii_sell / divisor,
      fii_net,
      dii_buy:   v.dii_buy / divisor,
      dii_sell:  v.dii_sell / divisor,
      dii_net,
      fii_label: fii_net > 0
        ? `FII net bought ₹${Math.abs(fii_net).toFixed(0)} Cr`
        : `FII net sold ₹${Math.abs(fii_net).toFixed(0)} Cr`,
      dii_label: dii_net > 0
        ? `DII net bought ₹${Math.abs(dii_net).toFixed(0)} Cr`
        : `DII net sold ₹${Math.abs(dii_net).toFixed(0)} Cr`,
    };
  });
}

// ── Main compute function ─────────────────────────────────────────

export async function computeMarketIntelligence(): Promise<MarketIntelligenceResult> {

  // ── Step 0: Check intelligence cache ────────────────────────────
  // 1. In-process memory cache (survives Redis being disabled)
  //    Skip if cached result is missing EITHER side of the movers list
  //    — a half-empty cache (e.g. gainers populated, losers=[] from a
  //    transient bullish-day fetch) used to stay valid for the entire
  //    MEM_CACHE_TTL_MS, which is exactly how production ended up
  //    serving "Last close losers unavailable" for ~60s windows even
  //    though the rankings table had real negatives. Both lists must
  //    be populated for the cache to be considered usable; otherwise
  //    we recompute (which now hits the sign-filtered MySQL fallback).
  const memValid = _memCache &&
    Date.now() - _memCacheAt < MEM_CACHE_TTL_MS &&
    _memCache.top_gainers.length > 0 &&
    _memCache.top_losers.length  > 0;
  if (memValid) return _memCache!;
  // 2. Redis cache — apply the same "both sides populated" gate so a
  //    cross-process Redis snapshot from a transient bullish/bearish
  //    sweep can never serve a half-empty movers list to the dashboard.
  //    The previous implementation accepted any non-null cached value,
  //    which is how production kept rendering "Last close losers
  //    unavailable" even after the MySQL fallback was wired.
  const cached = await cacheGet<MarketIntelligenceResult>(INTEL_CACHE_KEY);
  if (cached
      && cached.top_gainers?.length > 0
      && cached.top_losers?.length  > 0) {
    _memCache = cached; _memCacheAt = Date.now(); return cached;
  }

  // ════════════════════════════════════════════════════════════════
  // UNIFIED DATA: Breadth, gainers, losers, and sectors from ONE
  // atomic source (Kite → market stocks → indices fallback). // @deprecated marker
  // No mixing. Every derived field traces to the same snapshot.
  // ════════════════════════════════════════════════════════════════
  const unified = await fetchUnifiedMarketData();

  let dataSource: MarketIntelligenceResult['data_source'] =
    unified.source === 'kite' ? 'redis' : // @deprecated marker
    unified.source === 'market_stocks' ? 'mixed' : 'mysql';
  let oldestSnapshotMs: number | null = null;

  let advancing  = unified.breadth.advancing;
  let declining  = unified.breadth.declining;
  let unchanged  = unified.breadth.unchanged;
  let trendScore = 0;

  // Closed-market fallback: when the unified provider returns 0/0/0
  // (typical on weekends / pre-open before the upstream feed is
  // refreshed), fall back to the rankings table so breadth still has
  // a usable last-close signal. The dashboard previously showed
  // "Breadth data unavailable — insufficient sample" while Volatility
  // (which already has its own MySQL fallback at getVolatilityMysql)
  // worked — that asymmetry was the bug. After this, breadth /
  // gainers / losers all use the same DB-backed last-close source as
  // volatility when the live feed is dry.
  if (advancing + declining + unchanged < 10) {
    const dbBreadth = await getTrendScoreMysql();
    if (dbBreadth.advancing + dbBreadth.declining > 0) {
      advancing  = dbBreadth.advancing;
      declining  = dbBreadth.declining;
      unchanged  = dbBreadth.unchanged;
      trendScore = dbBreadth.score;
      // The rankings-derived breadth is last-close data; mark the
      // overall envelope so the dashboard can label it honestly.
      dataSource = 'mysql';
      console.log(
        `[MarketIntel] breadth fallback → rankings DB ` +
        `adv=${advancing} dec=${declining} unc=${unchanged} score=${trendScore}`
      );
    }
  }

  // Derive trend score from unified breadth (or refine from DB fallback)
  const totalBreadthStocks = advancing + declining + unchanged;
  if (totalBreadthStocks > 0 && trendScore === 0) {
    const breadthPct = ((advancing - declining) / totalBreadthStocks) * 100;
    trendScore = Math.max(-100, Math.min(100, Math.round(breadthPct * 0.8)));
  }

  // Movers — already filtered (gainers positive, losers negative)
  let topGainers: MoverEntry[] = unified.topGainers.map(s => ({
    symbol: s.symbol, name: s.name, ltp: s.ltp,
    change_percent: s.changePct, change_abs: s.changeAbs, volume: s.volume,
  }));
  let topLosers: MoverEntry[] = unified.topLosers.map(s => ({
    symbol: s.symbol, name: s.name, ltp: s.ltp,
    change_percent: s.changePct, change_abs: s.changeAbs, volume: s.volume,
  }));

  // Same closed-market fallback for movers — derive from rankings
  // when the unified provider returned no movers. Without this, the
  // dashboard's Top Gainers/Losers cards looked empty even though the
  // rankings table had plenty of pct_change data from the last close.
  //
  // The fallback now logs a one-line diagnostic that shows
  //   total / positive / negative counts in the rankings table
  // so an operator can immediately tell whether an empty losers list
  // is "DB has no negatives" vs. "fallback is broken". This was the
  // missing observability that made the production "Last close losers
  // unavailable" symptom hard to diagnose against a fully-stocked
  // rankings table.
  if (topGainers.length === 0 || topLosers.length === 0) {
    try {
      const { rows } = await db.query(`
        SELECT
          SUM(CASE WHEN pct_change > 0 THEN 1 ELSE 0 END) AS pos,
          SUM(CASE WHEN pct_change < 0 THEN 1 ELSE 0 END) AS neg,
          SUM(CASE WHEN pct_change = 0 OR pct_change IS NULL THEN 1 ELSE 0 END) AS zero,
          COUNT(*) AS total
        FROM rankings
      `);
      const r: any = (rows as any[])[0] ?? {};
      console.log(
        `[MarketIntel] rankings movers diagnostic ` +
        `total=${toNum(r.total)} pos=${toNum(r.pos)} neg=${toNum(r.neg)} zero=${toNum(r.zero)} ` +
        `(unifiedGainers=${topGainers.length} unifiedLosers=${topLosers.length})`
      );
    } catch (err: any) {
      console.warn('[MarketIntel] movers diagnostic failed:', err?.message);
    }
  }
  if (topGainers.length === 0) {
    topGainers = await getMoversMysql('gainers', 10);
    if (topGainers.length > 0) {
      console.log(`[MarketIntel] gainers fallback → rankings DB (${topGainers.length} rows)`);
    } else {
      console.log(`[MarketIntel] gainers fallback returned 0 rows — DB has no positive pct_change`);
    }
  }
  if (topLosers.length === 0) {
    topLosers = await getMoversMysql('losers', 10);
    if (topLosers.length > 0) {
      console.log(`[MarketIntel] losers fallback → rankings DB (${topLosers.length} rows)`);
    } else {
      console.log(`[MarketIntel] losers fallback returned 0 rows — DB has no negative pct_change`);
    }
  }

  // Sectors — from unified provider
  const sectorStrength: SectorStrength[] = unified.sectors.map(s => ({
    sector: s.sector,
    change_percent: s.changePct,
    trend: s.trend,
  }));

  // Volatility ranges from unified stocks
  let allRangePcts: number[] = unified.stocks
    .filter(s => s.high > 0 && s.close > 0)
    .map(s => ((s.high - s.low) / s.close) * 100);

  // Live index data — still needed for VIX, regime engine, and composite classifier
  const cachedIndices = await cacheGet<any>(INDICES_CACHE_KEY);
  let indicesData: any[] = cachedIndices?.data ?? [];
  if (!indicesData.length) {
    try {
      const live = await fetchIndices();
      indicesData = live.map(i => ({
        index: i.name, name: i.name,
        percentChange: i.percentChange, last: i.last,
        variation: i.variation, high: i.high, low: i.low,
        advances: i.advances, declines: i.declines,
      }));
    } catch { /* live index feed unavailable */ }
  }

  console.log(
    `[MarketIntel] unified source=${unified.source} stocks=${unified.stockCount} ` +
    `adv=${advancing} dec=${declining} gainers=${topGainers.length} losers=${topLosers.length} ` +
    `sectors=${sectorStrength.length} complete=${unified.isComplete}`
  );

  // ── Step 6: FII/DII ─────────────────────────────────────────────
  // Primary: Redis cache. Fallback chain: MySQL macro_data → live fetch.
  const cachedFii = await cacheGet<any>(FIIDII_CACHE_KEY);
  let fiiDii: FiiDiiEntry[] = [];

  if (Array.isArray(cachedFii) && cachedFii.length) {
    fiiDii = normaliseFiiDii(cachedFii);
  } else {
    // MySQL fallback — macro_data table
    try {
      const { rows: macroRows } = await db.query(`
        SELECT indicator, value, period, updated_at
        FROM macro_data
        WHERE indicator IN ('FII_NET', 'DII_NET', 'FII_BUY', 'FII_SELL', 'DII_BUY', 'DII_SELL')
        ORDER BY updated_at DESC
        LIMIT 12
      `);
      if ((macroRows as any[]).length) {
        const m: Record<string, number> = {};
        (macroRows as any[]).forEach((r: any) => { m[r.indicator] = toNum(r.value); });
        const fiiNet = toNum(m.FII_NET ?? (m.FII_BUY ?? 0) - (m.FII_SELL ?? 0));
        const diiNet = toNum(m.DII_NET ?? (m.DII_BUY ?? 0) - (m.DII_SELL ?? 0));
        fiiDii = [{
          date: '', fii_buy: toNum(m.FII_BUY), fii_sell: toNum(m.FII_SELL), fii_net: fiiNet,
          dii_buy: toNum(m.DII_BUY), dii_sell: toNum(m.DII_SELL), dii_net: diiNet,
          fii_label: fiiNet > 0 ? `FII net bought ₹${(Math.abs(fiiNet)/100).toFixed(0)} Cr` : `FII net sold ₹${(Math.abs(fiiNet)/100).toFixed(0)} Cr`,
          dii_label: diiNet > 0 ? `DII net bought ₹${(Math.abs(diiNet)/100).toFixed(0)} Cr` : `DII net sold ₹${(Math.abs(diiNet)/100).toFixed(0)} Cr`,
        }];
      }
    } catch { /* macro_data unavailable */ }

    // Live fallback — fetch FII/DII directly if MySQL was also empty
    if (!fiiDii.length) {
      try {
        const liveFii = await fetchFiiDii();
        if (liveFii.length) {
          fiiDii = liveFii.map(r => ({
            date:      r.date,
            fii_buy:   r.fii_buy, fii_sell: r.fii_sell, fii_net: r.fii_net,
            dii_buy:   r.dii_buy, dii_sell: r.dii_sell, dii_net: r.dii_net,
            fii_label: r.fii_net > 0
              ? `FII net bought ₹${(Math.abs(r.fii_net)/100).toFixed(0)} Cr`
              : `FII net sold ₹${(Math.abs(r.fii_net)/100).toFixed(0)} Cr`,
            dii_label: r.dii_net > 0
              ? `DII net bought ₹${(Math.abs(r.dii_net)/100).toFixed(0)} Cr`
              : `DII net sold ₹${(Math.abs(r.dii_net)/100).toFixed(0)} Cr`,
          }));
        }
      } catch { /* live FII feed unavailable */ }
    }
  }

  // ── Step 7: Volatility ───────────────────────────────────────────
  let volatility: VolatilityMetrics;
  if (allRangePcts.length > 10) {
    // Derive from Redis snapshot ranges
    const avgRange   = allRangePcts.reduce((a, b) => a + b, 0) / allRangePcts.length;
    const highVolCnt = allRangePcts.filter(r => r > 3).length;
    const lowVolCnt  = allRangePcts.filter(r => r < 1).length;
    const label: VolatilityMetrics['volatility_label'] =
      avgRange > 4   ? 'Very High' :
      avgRange > 2.5 ? 'High'      :
      avgRange > 1   ? 'Normal'    : 'Low';

    // Try to get India VIX from cached indices
    const vixIdx = indicesData.find((d: any) => d.index === 'INDIA VIX' || d.name === 'INDIA VIX');
    const niftyVix = vixIdx ? toNum(vixIdx.last ?? vixIdx.lastPrice ?? null) : null;

    volatility = {
      nifty_vix:        niftyVix,
      avg_range_pct:    parseFloat(avgRange.toFixed(2)),
      high_vol_count:   highVolCnt,
      low_vol_count:    lowVolCnt,
      volatility_label: label,
    };
  } else {
    // MySQL fallback
    volatility = await getVolatilityMysql();
    // Still try VIX from cached indices if available
    if (indicesData.length) {
      const vixIdx = indicesData.find((d: any) => d.index === 'INDIA VIX' || d.name === 'INDIA VIX');
      if (vixIdx) volatility.nifty_vix = toNum(vixIdx.last ?? vixIdx.lastPrice ?? null);

      // avg_range fallback — derive from Nifty 500 index when no candle data
      if (volatility.avg_range_pct === 0) {
        const n500 = indicesData.find((d: any) => d.index === 'NIFTY 500' || d.name === 'NIFTY 500');
        if (n500?.high && n500?.low && n500?.last) {
          volatility.avg_range_pct = parseFloat(((n500.high - n500.low) / n500.last * 100).toFixed(2));
          // Recompute label for the new value
          const r = volatility.avg_range_pct;
          volatility.volatility_label =
            r > 4   ? 'Very High' :
            r > 2.5 ? 'High'      :
            r > 1   ? 'Normal'    : 'Low';
        }
      }
    }
  }

  // ── Step 7.5: NIFTY-50 regime (structural EMA/RSI view) ─────────
  // This is the signal engine's detectEnhancedRegime output — a
  // purely technical view of the NIFTY candles. We keep it as ONE
  // input into the composite classifier below, not as the final
  // label. It can say "Strong Bullish" while breadth is collapsing,
  // which is exactly the failure mode we're blocking.
  let engineRegime: string | null = null;
  let engineStrength: number | null = null;
  try {
    const benchCandles = await fetchBenchmarkCandles();
    if (benchCandles.length >= 200) {
      const enhanced = detectEnhancedRegime(benchCandles);
      engineRegime   = enhanced.label;
      engineStrength = enhanced.strength;
      console.log(
        `[MarketIntel] NIFTY 50 engine regime=${enhanced.label} ` +
        `strength=${enhanced.strength} vol=${enhanced.volatilityRegime} ` +
        `conf=${enhanced.confidence}  candles=${benchCandles.length}`
      );
    } else {
      console.log(
        `[MarketIntel] benchmark candles insufficient (${benchCandles.length}) — ` +
        `skipping engine regime, composite classifier will use breadth only`
      );
    }
  } catch (err: any) {
    console.warn('[MarketIntel] regime detection failed:', err?.message);
  }

  // ── Step 7.6: Composite regime (INSTITUTIONAL-GRADE) ────────────
  // Blends every signal we have — engine (EMAs), breadth %, VIX,
  // sector strength, FII flow — into a single verdict with a hard
  // rejection rule that prevents "Strong Bull" from showing while
  // the underlying tape is obviously broken. See classifyCompositeRegime.
  const totalBreadth = advancing + declining + unchanged;
  const advPct = totalBreadth > 0 ? (advancing / totalBreadth) * 100 : 50;
  const decPct = totalBreadth > 0 ? (declining / totalBreadth) * 100 : 50;
  const vix    = volatility.nifty_vix ?? 0;
  const redSectorPct = sectorStrength.length > 0
    ? (sectorStrength.filter(s => s.change_percent < 0).length / sectorStrength.length) * 100
    : 0;
  const fiiNet = fiiDii?.[0]?.fii_net ?? 0;

  const composite = classifyCompositeRegime({
    trendScore,
    advPct,
    decPct,
    vix,
    redSectorPct,
    fiiNet,
    engineRegime,
    engineStrength,
  });

  const regimeLabel: string = composite.regime;
  const engineMarketTrend: MarketTrend = composite.regime as MarketTrend;

  console.log('[REGIME DEBUG]', {
    trendScore,
    breadth:        { advancing, declining, advPct: Number(advPct.toFixed(1)), decPct: Number(decPct.toFixed(1)) },
    vix,
    sectorStrength: { total: sectorStrength.length, redPct: Number(redSectorPct.toFixed(1)) },
    flow:           { fii_net: fiiNet, dii_net: fiiDii?.[0]?.dii_net ?? 0 },
    engineRegime,
    engineStrength,
    finalRegime:    composite.regime,
    confidence:     composite.confidence,
    reason:         composite.reason,
  });

  // ── Step 8: Assemble result ──────────────────────────────────────
  const cacheAgeSec = oldestSnapshotMs
    ? Math.round((Date.now() - oldestSnapshotMs) / 1000)
    : null;

  const weakMarket =
    composite.regime === 'Bear' ||
    composite.regime === 'Strong Bear' ||
    composite.confidence < 60 ||
    advPct < 40 ||
    vix > 20;

  const result: MarketIntelligenceResult = {
    market_trend:     engineMarketTrend,
    trend_score:      trendScore,
    advancing,
    declining,
    unchanged,
    sector_strength:  sectorStrength,
    top_gainers:      topGainers,
    top_losers:       topLosers,
    fii_dii:          fiiDii,
    volatility,
    as_of:            new Date().toISOString(),
    data_source:      dataSource,
    cache_age_sec:    cacheAgeSec,
    regime_label:     regimeLabel,
    regime_confidence: composite.confidence,
    regime_reason:    composite.reason,
    weak_market:      weakMarket,
  };

  // Cache the computed result for 60s
  // Redis: for cross-process sharing (scheduler → API routes)
  // Memory: so scenario engine can read it in the same process/request cycle
  await cacheSet(INTEL_CACHE_KEY, result, INTEL_CACHE_TTL);
  _memCache   = result;
  _memCacheAt = Date.now();

  return result;
}
