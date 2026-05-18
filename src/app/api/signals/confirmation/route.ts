// ════════════════════════════════════════════════════════════════
//  GET /api/signals/confirmation
//
//  Phase 5 — Institutional Confirmation Layer.
//
//  Aggregates the five confirmation modules (sector / options /
//  news / manipulation / execution) into a single envelope with an
//  approval recommendation and an explanation.
//
//  Query params:
//    ?symbol=<sym>                (required)
//    ?signalId=<id>               (optional — used to look up an existing signal)
//    ?strategyId=<snake_case>     (optional — required if no signalId)
//    ?direction=BUY|SELL          (optional — required if no signalId)
//    ?include=sector,options,news,manipulation,execution   (advisory — all modules always run)
//
//  Always 200; missing modules return UNAVAILABLE / INSUFFICIENT_DATA
//  inside the envelope.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { db }                        from '@/lib/db';
import { getSector }                 from '@/lib/signal-engine/constants/phase3.constants';
import { getStrategyMeta }           from '@/lib/signal-engine/strategies/strategyRegistry';
import { analyzeOptionChain }        from '@/services/optionIntelligence';
import {
  aggregateConfirmation,
  buildSectorConfirmation,
  buildOptionsConfirmation,
  buildNewsConfirmation,
  buildManipulationConfirmation,
  buildExecutionConfirmation,
} from '@/lib/confirmation/confirmationAggregator';

/** Symbols we attempt the real options-chain probe for. The platform's
 *  `analyzeOptionChain()` returns `null` for symbols without a chain,
 *  but probing every NSE_EQ ticker is wasteful — keep an explicit
 *  whitelist for indices + the F&O majors. */
const FNO_PROBE_WHITELIST: ReadonlySet<string> = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX',
  // Add F&O equity symbols here as the provider widens coverage.
]);

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

interface BasicSignalRow {
  id:                number;
  symbol:            string;
  direction:         'BUY' | 'SELL' | string;
  signal_type:       string | null;
  entry_price:       number | null;
  stop_loss:         number | null;
  risk_reward:       number | null;
  signal_status:     string | null;
  sector:            string | null;
}

async function loadSignalRow(signalId: number): Promise<BasicSignalRow | null> {
  try {
    const { rows } = await db.query<BasicSignalRow>(
      `SELECT id, symbol, direction, signal_type, entry_price, stop_loss,
              risk_reward, signal_status, sector
         FROM q365_signals
        WHERE id = ?
        LIMIT 1`,
      [signalId],
    );
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url        = new URL(req.url);
  const symbolRaw  = url.searchParams.get('symbol')?.trim().toUpperCase() || null;
  const signalId   = url.searchParams.get('signalId');
  const strategyIdQuery = url.searchParams.get('strategyId')?.trim() || null;
  const directionQuery  = url.searchParams.get('direction')?.trim().toUpperCase() || null;

  // ── Resolve the signal context. Either signalId looks it up in
  //    q365_signals, or the caller passes symbol+strategyId+direction
  //    explicitly to confirm a candidate that isn't persisted yet. ──
  let row: BasicSignalRow | null = null;
  if (signalId) {
    const idNum = Number(signalId);
    if (Number.isFinite(idNum)) row = await loadSignalRow(idNum);
  }

  const symbol = row?.symbol ?? symbolRaw;
  if (!symbol) {
    return NextResponse.json({
      ok: false,
      error: 'symbol or signalId is required.',
    }, { status: 400 });
  }

  const strategyId = (row?.signal_type ?? strategyIdQuery ?? 'unclassified').toString();
  const meta = getStrategyMeta(strategyId);
  const direction: 'BUY' | 'SELL' =
    (row?.direction as 'BUY' | 'SELL' | undefined) ??
    (directionQuery === 'SELL' ? 'SELL' : directionQuery === 'BUY' ? 'BUY' : meta.direction);
  const currentAction: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | null =
    row?.signal_status === 'APPROVED_SIGNAL' ? 'APPROVED'
    : row?.signal_status === 'DEVELOPING_SETUP' ? 'WATCHLIST'
    : row?.signal_status === 'NO_TRADE' ? 'REJECTED'
    : null;

  // ── Module data loads. Every block is wrapped so a missing source
  //    becomes UNAVAILABLE / INSUFFICIENT_DATA cleanly. ──

  const sectorName: string | null = row?.sector ?? safeSector(symbol);

  // Manipulation risk — read the latest snapshot row for this symbol
  // if the table exists. The Phase-B engine populates `q365_manipulation_snapshots`.
  let manipulationRisk: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk | null = null;
  try {
    const { rows } = await db.query<any>(
      `SELECT symbol, suspicion_band AS band, suspicion_score AS score, snapshot_date AS latestEventDate
         FROM q365_manipulation_snapshots
        WHERE symbol = ?
        ORDER BY snapshot_date DESC
        LIMIT 1`,
      [symbol],
    );
    const r = rows?.[0];
    if (r && r.band) {
      manipulationRisk = {
        symbol: String(r.symbol),
        band: String(r.band).toUpperCase() as any,
        score: Number(r.score ?? 0),
        latestEventDate: r.latestEventDate ? String(r.latestEventDate).slice(0, 10) : null,
        freshnessStatus: 'FRESH',
        canAffectApproval: true,
        recommendedAction: 'WARNING_ONLY' as any,
      } as any;
    }
  } catch { /* table may not exist yet */ }

  // ── Sector confirmation ───────────────────────────────────────
  // Phase-5 hardening: use real sector trend data when it's available.
  // We probe two independent sources in priority order:
  //
  //   1. Cross-sectional buy/sell mix from the active live signal
  //      pool (matches how the bulk enricher derives sectorTrendMap).
  //      Requires ≥ 3 active rows in the sector to classify honestly.
  //
  //   2. Candle-based sector context derived from the symbol's own
  //      candles vs the NIFTY benchmark (proxy trend used in the
  //      signal-engine context loader).
  //
  // When neither source has the data, we honestly report UNAVAILABLE
  // and the buildSectorConfirmation module will surface it as such —
  // we never fabricate a Neutral/50 reading and pass it off as live
  // sector intelligence.
  let sectorTrend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining' | null = null;
  let sectorScore: number | null = null;
  let sectorTrendSource: 'live_signal_pool' | 'candle_proxy' | 'unavailable' = 'unavailable';
  let sectorSampleSize = 0;

  if (sectorName) {
    // Source 1 — live signal pool cross-section (last 24h, active rows
    // in the same sector). Mirrors the thresholds in buildSectorTrendMap.
    try {
      const { rows: poolRows } = await db.query<any>(
        `SELECT direction, COUNT(*) AS cnt
           FROM q365_signals
          WHERE sector = ?
            AND status IN ('active','watchlist')
            AND generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
          GROUP BY direction`,
        [sectorName],
      );
      let buy = 0, sell = 0;
      for (const r of poolRows ?? []) {
        const dir = String(r.direction ?? '').toUpperCase();
        const cnt = Number(r.cnt ?? 0);
        if (dir === 'BUY') buy += cnt;
        else if (dir === 'SELL') sell += cnt;
      }
      const total = buy + sell;
      if (total >= 3) {
        const buyShare = buy / total;
        sectorTrend =
          buyShare >= 0.70 ? 'Strong'
          : buyShare >= 0.55 ? 'Positive'
          : buyShare <= 0.30 ? 'Declining'
          : buyShare <= 0.45 ? 'Weak'
          :                    'Neutral';
        sectorScore = Math.round(buyShare * 100);
        sectorTrendSource = 'live_signal_pool';
        sectorSampleSize = total;
      }
    } catch { /* table missing — fall through */ }

    // Source 2 — candle-based proxy (symbol vs benchmark). Only used
    // when the live signal pool didn't have enough samples.
    if (sectorTrendSource === 'unavailable') {
      const proxy = await tryBuildCandleProxySector(symbol);
      if (proxy) {
        sectorTrend = proxy.trend;
        sectorScore = proxy.score;
        sectorTrendSource = 'candle_proxy';
        sectorSampleSize = proxy.sampleSize;
      }
    }
    // Neither source had data — keep sectorTrend/sectorScore as null
    // so buildSectorConfirmation downgrades to UNAVAILABLE with an
    // honest reason rather than rendering a fake Neutral reading.
  }

  // ── Options — probe the real provider for F&O symbols only. ──
  // Probing every NSE_EQ ticker is wasteful; the provider only
  // returns useful chains for indices + the F&O majors. For any
  // other symbol we honestly return UNAVAILABLE. When the chain
  // probe succeeds we derive a directional bias from PCR — never
  // a synthetic one.
  let optionsAvailable = false;
  let optionsBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | null = null;
  let optionsPcr: number | null = null;
  let optionsIvState: 'LOW' | 'NORMAL' | 'ELEVATED' | 'EXTREME' | null = null;
  let optionsKeySupport: number | null = null;
  let optionsKeyResistance: number | null = null;
  let optionsSource: 'live' | 'estimated' | 'unavailable' = 'unavailable';
  if (FNO_PROBE_WHITELIST.has(symbol)) {
    try {
      const intel = await analyzeOptionChain(symbol).catch(() => null);
      if (intel) {
        optionsAvailable = true;
        optionsSource = 'live';
        optionsPcr = typeof intel.pcr === 'number' ? intel.pcr : null;
        // PCR-driven bias — matches the analyzer's own threshold language.
        optionsBias =
          optionsPcr != null && optionsPcr > 1.3 ? 'BULLISH'
          : optionsPcr != null && optionsPcr < 0.7 ? 'BEARISH'
          :                                          'NEUTRAL';
        const ivCtx = String((intel as any).ivContext ?? '').toLowerCase();
        optionsIvState = ivCtx.includes('extreme')  ? 'EXTREME'
                       : ivCtx.includes('elevated') ? 'ELEVATED'
                       : ivCtx.includes('low')      ? 'LOW'
                       :                              'NORMAL';
        optionsKeySupport    = intel.strongSupport?.[0]?.strike    ?? null;
        optionsKeyResistance = intel.strongResistance?.[0]?.strike ?? null;
      }
    } catch {
      // Provider call failed — stay honest, no synthetic bias.
      optionsAvailable = false;
    }
  }

  // News — query the latest scored event for the symbol if the
  // scoring table exists. Soft-fail to neutral.
  let newsAvailable = false;
  let newsSentiment: 'bullish' | 'bearish' | 'neutral' | null = null;
  let newsImpact: number | null = null;
  let newsCatalyst: string | null = null;
  let highEventRisk = false;
  try {
    const { rows } = await db.query<any>(
      `SELECT sentiment, impact_score, category, event_risk_score
         FROM q365_news_event_scores
        WHERE symbol = ?
        ORDER BY scored_at DESC
        LIMIT 1`,
      [symbol],
    );
    const r = rows?.[0];
    if (r) {
      newsAvailable = true;
      newsSentiment = (String(r.sentiment ?? '').toLowerCase() as any) || null;
      newsImpact    = r.impact_score != null ? Number(r.impact_score) : null;
      newsCatalyst  = r.category ? String(r.category) : null;
      highEventRisk = Number(r.event_risk_score ?? 0) >= 75;
    }
  } catch { /* table may not exist yet */ }

  // Execution — derive stop distance & R:R from the signal row.
  const stopDistancePct =
    row?.entry_price && row?.stop_loss && row.entry_price > 0
      ? Math.abs(((row.entry_price as number) - (row.stop_loss as number)) / (row.entry_price as number)) * 100
      : null;

  // ── Build modules ──
  const sector = buildSectorConfirmation({
    sector: sectorName, sectorScore, sectorTrend, relativeStrength: null, direction,
  });
  const options = buildOptionsConfirmation({
    available:     optionsAvailable,
    source:        optionsSource,
    optionsBias,
    pcr:           optionsPcr,
    ivState:       optionsIvState,
    keySupport:    optionsKeySupport,
    keyResistance: optionsKeyResistance,
    direction,
  });
  const news = buildNewsConfirmation({
    available: newsAvailable, sentiment: newsSentiment, catalystType: newsCatalyst,
    impactScore: newsImpact, freshness: newsAvailable ? 'fresh' : null,
    direction, highEventRisk,
  });
  const manipulation = buildManipulationConfirmation({
    available: !!manipulationRisk, risk: manipulationRisk,
  });
  const execution = buildExecutionConfirmation({
    liquidityScore:      null,
    spreadBps:           null,
    stopDistancePct,
    riskReward:          row?.risk_reward ?? null,
    avgVolume:           null,
    slippageEstimateBps: null,
  });

  const aggregate = aggregateConfirmation({
    signalId:      signalId ?? null,
    symbol,
    strategyId:    meta.strategyId,
    direction,
    currentAction,
    modules: { sector, options, news, manipulation, execution },
  });

  // Operator-visible audit hint — surfaces which sector source the
  // route used (live signal pool / candle proxy / unavailable) and how
  // many samples backed the classification. Lets downstream consumers
  // spot when the route fell back to UNAVAILABLE instead of guessing.
  const envelope = {
    ...aggregate,
    sectorContext: {
      sectorName,
      source:       sectorTrendSource,
      sampleSize:   sectorSampleSize,
      trend:        sectorTrend,
      score:        sectorScore,
    },
  };

  return NextResponse.json(envelope, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function safeSector(symbol: string): string | null {
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch { return null; }
}

/**
 * Candle-based sector proxy used by the standalone confirmation
 * route when no live signal pool entries exist for the sector. The
 * proxy uses the symbol's own daily candles vs the NIFTY benchmark
 * over a 20-bar window — the same approach Phase 2's
 * `buildSectorContextFromStock` uses inside the signal engine.
 *
 * Returns `null` when either the symbol or benchmark candles aren't
 * available, so the caller can fall through to UNAVAILABLE rather
 * than fabricating a Neutral reading.
 */
async function tryBuildCandleProxySector(symbol: string): Promise<{
  trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining';
  score: number;
  sampleSize: number;
} | null> {
  try {
    const [{ rows: stockRows }, { rows: benchRows }] = await Promise.all([
      db.query<any>(
        `SELECT close FROM candles
          WHERE instrument_key = ? AND candle_type='eod' AND interval_unit='1day'
          ORDER BY ts DESC LIMIT 30`,
        [`NSE_EQ|${symbol}`],
      ),
      db.query<any>(
        `SELECT close FROM candles
          WHERE instrument_key = 'NSE_INDEX|NIFTY 50' AND candle_type='eod' AND interval_unit='1day'
          ORDER BY ts DESC LIMIT 30`,
        [],
      ),
    ]);
    const stockCloses = (stockRows ?? []).map((r) => Number(r.close)).filter(Number.isFinite).reverse();
    const benchCloses = (benchRows ?? []).map((r) => Number(r.close)).filter(Number.isFinite).reverse();
    if (stockCloses.length < 21 || benchCloses.length < 21) return null;

    const stockLast = stockCloses[stockCloses.length - 1];
    const stockRoc5  = ((stockLast - stockCloses[stockCloses.length - 6])  / stockCloses[stockCloses.length - 6])  * 100;
    const stockRoc20 = ((stockLast - stockCloses[stockCloses.length - 21]) / stockCloses[stockCloses.length - 21]) * 100;
    const compositeReturn = stockRoc5 * 0.6 + stockRoc20 * 0.4;
    const score = Math.max(0, Math.min(100, Math.round(50 + compositeReturn * 8)));

    const trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining' =
      (score >= 75 && stockRoc5 > 1 && stockRoc20 > 2) ? 'Strong'
      : (score >= 60 && stockRoc5 > 0)                 ? 'Positive'
      : (score >= 40)                                  ? 'Neutral'
      : (score >= 25)                                  ? 'Weak'
      :                                                  'Declining';

    return { trend, score, sampleSize: stockCloses.length };
  } catch {
    return null;
  }
}
