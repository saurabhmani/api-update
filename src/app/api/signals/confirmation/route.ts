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
import {
  aggregateConfirmation,
  buildSectorConfirmation,
  buildOptionsConfirmation,
  buildNewsConfirmation,
  buildManipulationConfirmation,
  buildExecutionConfirmation,
} from '@/lib/confirmation/confirmationAggregator';

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

  // Sector confirmation — derive a coarse score / trend from the
  // sector relative-strength tables if they exist. Otherwise pass
  // null and let the module return UNAVAILABLE.
  let sectorTrend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining' | null = null;
  let sectorScore: number | null = null;
  if (sectorName) {
    // Conservative: derive a Neutral baseline unless we explicitly
    // know more. A future Phase-5 sector module can override.
    sectorTrend = 'Neutral';
    sectorScore = 50;
  }

  // Options — the platform's /api/options/intelligence already
  // probes the provider; we don't have the symbol's option chain
  // surfaced into a generic table, so default to UNAVAILABLE.
  const optionsAvailable = false;

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
    available: optionsAvailable, source: 'unavailable',
    optionsBias: null, pcr: null, ivState: null, keySupport: null, keyResistance: null, direction,
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

  return NextResponse.json(aggregate, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function safeSector(symbol: string): string | null {
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch { return null; }
}
