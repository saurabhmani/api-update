// ════════════════════════════════════════════════════════════════
//  GET /api/signals/explain
//
//  Phase 6 — Institutional Explanation API.
//
//  Returns a structured explanation for a signal: why it was
//  generated, why now, why approved/watchlisted/rejected, what
//  confirms it, what invalidates it, what to watch next.
//
//  Query params:
//    ?signalId=<id>             (preferred — looks up q365_signals)
//    ?symbol=<sym>              (required if no signalId)
//    ?strategyId=<snake_case>   (required if no signalId)
//
//  Always 200. When the signal can't be resolved we still emit an
//  explanation with INSUFFICIENT_DATA-style copy.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { db }                        from '@/lib/db';
import { getStrategyMeta }           from '@/lib/signal-engine/strategies/strategyRegistry';
import { explainSignal }             from '@/lib/explainability/signalExplanation';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url        = new URL(req.url);
  const signalId   = url.searchParams.get('signalId');
  const symbolRaw  = url.searchParams.get('symbol')?.trim().toUpperCase() || null;
  const strategyIdQ = url.searchParams.get('strategyId')?.trim() || null;

  let row: any = null;
  if (signalId) {
    const id = Number(signalId);
    if (Number.isFinite(id)) {
      try {
        const r = await db.query<any>(
          `SELECT id, symbol, direction, signal_type, confidence_score, risk_reward,
                  market_regime, signal_status, decay_state, rejection_reasons_json
             FROM q365_signals
            WHERE id = ?
            LIMIT 1`,
          [id],
        );
        row = r.rows?.[0] ?? null;
      } catch { /* table missing */ }
    }
  }

  const symbol     = row?.symbol ?? symbolRaw;
  const strategyId = (row?.signal_type ?? strategyIdQ ?? 'unclassified').toString();
  if (!symbol) {
    return NextResponse.json({
      ok: false,
      error: 'signalId or symbol is required.',
    }, { status: 400 });
  }

  const meta = getStrategyMeta(strategyId);
  const direction: 'BUY' | 'SELL' =
    (row?.direction as 'BUY' | 'SELL' | undefined) ?? meta.direction;
  const action: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | null =
    row?.signal_status === 'APPROVED_SIGNAL' ? 'APPROVED'
    : row?.signal_status === 'DEVELOPING_SETUP' ? 'WATCHLIST'
    : row?.signal_status === 'NO_TRADE' ? 'REJECTED'
    : null;

  let rejectionReasons: string[] = [];
  if (row?.rejection_reasons_json) {
    try {
      const parsed = typeof row.rejection_reasons_json === 'string'
        ? JSON.parse(row.rejection_reasons_json)
        : row.rejection_reasons_json;
      if (Array.isArray(parsed)) rejectionReasons = parsed.filter((s) => typeof s === 'string');
    } catch { /* leave empty */ }
  }

  const explanation = explainSignal({
    signalId:        signalId ?? (row?.id ? String(row.id) : null),
    symbol,
    strategyId:      meta.strategyId,
    direction,
    action,
    confidenceScore: typeof row?.confidence_score === 'number' ? row.confidence_score : null,
    riskReward:      typeof row?.risk_reward === 'number' ? row.risk_reward : null,
    marketRegime:    row?.market_regime ?? null,
    freshnessState:  row?.decay_state ?? null,
    rejectionReasons,
  });

  return NextResponse.json(explanation, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
