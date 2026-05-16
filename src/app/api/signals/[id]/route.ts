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
import { getConfirmedSnapshotById } from '@/lib/signal-engine/repository/readConfirmedSnapshots';

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
    // Two-layer lookup. Treat the id as a confirmed-snapshot id first;
    // if not found, fall through to the legacy q365_signals path so
    // older deep-links continue to resolve. The frontend's signal-
    // detail page uses snapshot ids by default once the dashboard is
    // serving from confirmed snapshots.
    const snapshot = await getConfirmedSnapshotById(signalId);
    if (snapshot) {
      // Lifecycle history for a snapshot is currently a single row
      // ("CONFIRMED at confirmed_at"). When the lifecycle worker
      // transitions status, status_changed_at moves; the audit trail
      // collapses to the current status. Return a synthetic two-row
      // history so the UI can render a timeline without a separate
      // lifecycle table.
      const history = [
        { state: 'CONFIRMED', reason: 'all_gates_passed', changed_at: snapshot.confirmed_at },
      ];
      if (snapshot.status !== 'ACTIVE') {
        history.push({
          state:      snapshot.status,
          reason:     snapshot.invalidation_reason ?? 'lifecycle_transition',
          changed_at: snapshot.status_changed_at,
        });
      }
      return NextResponse.json({
        signal: {
          id:                              snapshot.id,
          source_signal_id:                snapshot.source_signal_id,
          symbol:                          snapshot.symbol,
          direction:                       snapshot.direction,
          strategy:                        snapshot.strategy,
          confidence_score:                snapshot.confidence_score,
          final_score:                     snapshot.final_score,
          classification:                  snapshot.classification,
          entry_price:                     snapshot.entry_price,
          stop_loss:                       snapshot.stop_loss,
          target1:                         snapshot.target1,
          target2:                         snapshot.target2,
          risk_reward:                     snapshot.risk_reward,
          profit_percent:                  snapshot.profit_percent,
          loss_percent:                    snapshot.loss_percent,
          expected_edge_percent:           snapshot.expected_edge_percent,
          win_probability:                 snapshot.win_probability,
          status:                          snapshot.status,
          confirmed_at:                    snapshot.confirmed_at,
          valid_until:                     snapshot.valid_until,
          status_changed_at:               snapshot.status_changed_at,
          invalidation_reason:             snapshot.invalidation_reason,
          factor_scores:                   snapshot.factor_scores,
          explanation:                     snapshot.explanation,
          gate_details:                    snapshot.gate_details,

          // Maturity layer
          maturity_score:                  snapshot.maturity_score,
          validation_cycles_passed:        snapshot.validation_cycles_passed,
          signal_age_minutes_at_promotion: snapshot.signal_age_minutes_at_promotion,
          conviction_level:                snapshot.conviction_level,
          stability_passed:                snapshot.stability_passed,
          maturity_factors:                snapshot.maturity_factors,
        },
        lifecycle_history: history,
        source: 'confirmed_snapshot',
      });
    }

    // Legacy fallback — id refers to a row in q365_signals (the live
    // scanner table). Useful for historical deep-links and audits.
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
      source: 'live_scanner_signal',
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
