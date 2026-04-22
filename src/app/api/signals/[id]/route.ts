// ════════════════════════════════════════════════════════════════
//  GET /api/signals/:id
//
//  Returns a single signal by id with its full lifecycle history
//  in chronological order. Phase 3 §3 — lifecycle audit visibility.
//
//  This is intentionally a thin, focused endpoint. For the richer
//  Phase 3/4 artifact chain (trade plan, sizing, portfolio fit,
//  explanations, decision memory, conflicts, strategy breakdowns)
//  use /api/signal-engine/insights?signalId=<id>.
//
//  Response shape:
//    {
//      signal: {
//        id, symbol, direction, signal_type, confidence_score,
//        confidence_band, risk_score, risk_band, market_regime,
//        entry_price, stop_loss, target1, target2, risk_reward,
//        status, generated_at, generation_source
//      },
//      lifecycle_history: [
//        { state, reason, changed_at }, ...
//      ]
//    }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface SignalRow {
  id: number;
  symbol: string;
  direction: string;
  signal_type: string;
  confidence_score: number;
  confidence_band: string;
  risk_score: number;
  risk_band: string;
  market_regime: string;
  entry_price: string | number;
  stop_loss: string | number;
  target1: string | number;
  target2: string | number | null;
  risk_reward: string | number;
  status: string;
  generated_at: Date | string;
  generation_source: string | null;
}

interface LifecycleRow {
  state: string;
  reason: string;
  changed_at: Date | string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const signalId = parseInt(params.id, 10);
  if (!signalId || Number.isNaN(signalId)) {
    return NextResponse.json(
      { error: 'Invalid signal id' },
      { status: 400 },
    );
  }

  try {
    const [signalResult, lifecycleResult] = await Promise.all([
      db.query<SignalRow>(
        `SELECT id, symbol, direction, signal_type,
                confidence_score, confidence_band,
                risk_score, risk_band, market_regime,
                entry_price, stop_loss, target1, target2, risk_reward,
                status, generated_at, generation_source
           FROM q365_signals
          WHERE id = ?
          LIMIT 1`,
        [signalId],
      ),
      // Chronological — oldest first. This is the canonical order
      // for lifecycle audit: readers expect the first row to be
      // 'generated' and the last row to be the current state.
      db.query<LifecycleRow>(
        `SELECT state, reason, changed_at
           FROM q365_signal_lifecycle
          WHERE signal_id = ?
          ORDER BY changed_at ASC, id ASC`,
        [signalId],
      ),
    ]);

    if (signalResult.rows.length === 0) {
      return NextResponse.json(
        { error: 'Signal not found' },
        { status: 404 },
      );
    }

    const row = signalResult.rows[0];

    // Normalize numeric columns — mysql2 returns DECIMAL as strings.
    const signal = {
      id: row.id,
      symbol: row.symbol,
      direction: row.direction,
      signal_type: row.signal_type,
      confidence_score: Number(row.confidence_score),
      confidence_band: row.confidence_band,
      risk_score: Number(row.risk_score),
      risk_band: row.risk_band,
      market_regime: row.market_regime,
      entry_price: Number(row.entry_price),
      stop_loss: Number(row.stop_loss),
      target1: Number(row.target1),
      target2: row.target2 != null ? Number(row.target2) : null,
      risk_reward: Number(row.risk_reward),
      status: row.status,
      generated_at: row.generated_at,
      generation_source: row.generation_source,
    };

    return NextResponse.json({
      signal,
      lifecycle_history: lifecycleResult.rows,
    });
  } catch (err) {
    console.error(`[/api/signals/${signalId}]`, err);
    return NextResponse.json(
      {
        error: 'Failed to load signal',
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
