import { db } from '@/lib/db';
import type { ConfirmedSnapshotRow } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { getActiveConfirmedSnapshots } from '@/lib/signal-engine/repository/readConfirmedSnapshots';

const CLOSED_STATUSES = ['TARGET_HIT', 'STOP_LOSS_HIT', 'EXPIRED', 'INVALIDATED'] as const;

export interface SignalBoardFilters {
  status?: 'active' | 'closed' | 'all';
  direction?: 'BUY' | 'SELL';
  strategy?: string;
  limit?: number;
}

export async function loadSnapshotsForBoard(
  filters: SignalBoardFilters = {},
): Promise<ConfirmedSnapshotRow[]> {
  const status = filters.status ?? 'active';
  const limit = Math.min(200, Math.max(1, filters.limit ?? 50));

  if (status === 'active') {
    let rows = await getActiveConfirmedSnapshots();
    if (filters.direction) rows = rows.filter((r) => r.direction === filters.direction);
    if (filters.strategy) rows = rows.filter((r) => r.strategy === filters.strategy);
    return rows.slice(0, limit);
  }

  if (status === 'closed') {
    return loadClosedSnapshots(filters, limit);
  }

  const [active, closed] = await Promise.all([
    getActiveConfirmedSnapshots(),
    loadClosedSnapshots(filters, limit),
  ]);
  let combined = [...active, ...closed];
  if (filters.direction) combined = combined.filter((r) => r.direction === filters.direction);
  if (filters.strategy) combined = combined.filter((r) => r.strategy === filters.strategy);
  return combined.slice(0, limit);
}

async function loadClosedSnapshots(
  filters: SignalBoardFilters,
  limit: number,
): Promise<ConfirmedSnapshotRow[]> {
  const clauses = [`s.status IN (${CLOSED_STATUSES.map(() => '?').join(',')})`];
  const params: unknown[] = [...CLOSED_STATUSES];

  if (filters.direction) {
    clauses.push('s.direction = ?');
    params.push(filters.direction);
  }
  if (filters.strategy) {
    clauses.push('s.strategy = ?');
    params.push(filters.strategy);
  }
  params.push(limit);

  try {
    const { rows } = await db.query(
      `SELECT s.id, s.source_signal_id, s.symbol, s.exchange, s.direction, s.strategy,
              s.entry_price, s.stop_loss, s.target1, s.target2,
              s.profit_percent, s.loss_percent, s.expected_edge_percent,
              s.win_probability, s.rr_ratio, s.confidence_score, s.final_score,
              s.classification, s.status, s.confirmed_at, s.valid_until,
              s.invalidation_reason, s.explanation_json
         FROM q365_confirmed_signal_snapshots s
        WHERE ${clauses.join(' AND ')}
        ORDER BY s.status_changed_at DESC
        LIMIT ?`,
      params,
    );

    return (rows as Array<Record<string, unknown>>).map((r) => {
      const status = r.status as ConfirmedSnapshotRow['status'];
      const invalidation = r.invalidation_reason != null ? String(r.invalidation_reason) : null;
      return {
        id: Number(r.id),
        source_signal_id: r.source_signal_id != null ? Number(r.source_signal_id) : null,
        tradingsymbol: String(r.symbol ?? ''),
        symbol: String(r.symbol ?? ''),
        exchange: String(r.exchange ?? 'NSE'),
        direction: r.direction as 'BUY' | 'SELL',
        strategy: r.strategy != null ? String(r.strategy) : null,
        entry_price: Number(r.entry_price ?? 0),
        stop_loss: Number(r.stop_loss ?? 0),
        target1: Number(r.target1 ?? 0),
        target2: r.target2 != null ? Number(r.target2) : null,
        profit_percent: Number(r.profit_percent ?? 0),
        loss_percent: Number(r.loss_percent ?? 0),
        expected_edge_percent: Number(r.expected_edge_percent ?? 0),
        win_probability: Number(r.win_probability ?? 0),
        rr_ratio: Number(r.rr_ratio ?? 0),
        risk_reward: Number(r.rr_ratio ?? 0),
        confidence_score: Number(r.confidence_score ?? 0),
        confidence: Number(r.confidence_score ?? 0),
        final_score: r.final_score != null ? Number(r.final_score) : null,
        classification: r.classification != null ? String(r.classification) : null,
        status,
        confirmed_at: String(r.confirmed_at ?? ''),
        valid_until: String(r.valid_until ?? ''),
        status_changed_at: String(r.confirmed_at ?? ''),
        invalidation_reason: invalidation,
        validation_gates_passed: 0,
        valid_minutes_remaining: 0,
        rejection_codes: [],
        factor_scores: null,
        explanation: null,
        gate_details: null,
        stress_survival_score: null,
        live_valid: null,
        signal_status: 'APPROVED_SIGNAL' as const,
        approved: true,
        execution_allowed: false,
        rejection_reason: invalidation ?? status,
        maturity_score: null,
        validation_cycles_passed: null,
        signal_age_minutes_at_promotion: null,
        conviction_level: null,
        stability_passed: null,
        maturity_factors: null,
      } satisfies ConfirmedSnapshotRow;
    });
  } catch {
    return [];
  }
}
