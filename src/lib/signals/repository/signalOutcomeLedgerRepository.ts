// ════════════════════════════════════════════════════════════════
//  Public Signal Ledger — MySQL repository (migration 032)
//
//  Read/write q365_signal_outcomes public-ledger columns. Never
//  modifies q365_signals — source signals remain immutable.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  SignalOutcomeCoverage,
  SignalOutcomeLedgerInsert,
  SignalOutcomeLedgerListFilter,
  SignalOutcomeLedgerRow,
  SignalOutcomeLedgerStatus,
} from '../types/signalOutcomeLedger.types';

function mapRow(r: Record<string, unknown>): SignalOutcomeLedgerRow {
  return {
    id: Number(r.id),
    signalId: Number(r.signal_id),
    strategyId: String(r.strategy_id ?? r.strategy ?? ''),
    symbol: String(r.symbol ?? ''),
    outcome: String(r.outcome ?? 'INSUFFICIENT_DATA') as SignalOutcomeLedgerStatus,
    outcomeAt: String(r.outcome_at ?? r.evaluated_at ?? ''),
    daysHeld: Number(r.days_held ?? 0),
    maxGainPct: r.max_gain_pct != null ? Number(r.max_gain_pct) : null,
    candleCheckCount: Number(r.candle_check_count ?? 0),
    resolvedAt: String(r.resolved_at ?? r.evaluated_at ?? ''),
  };
}

function toMysqlDatetime(v: string | Date): string {
  const d = v instanceof Date ? v : new Date(v);
  if (!Number.isFinite(d.getTime())) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** Rows with public-ledger columns populated (excludes legacy-only rows). */
const LEDGER_WHERE = `signal_id IS NOT NULL AND strategy_id IS NOT NULL AND outcome IS NOT NULL AND outcome_at IS NOT NULL`;

export async function insertSignalOutcome(
  input: SignalOutcomeLedgerInsert,
): Promise<{ inserted: boolean; row: SignalOutcomeLedgerRow | null }> {
  const outcomeAt = toMysqlDatetime(input.outcomeAt);
  const resolvedAt = input.resolvedAt != null ? toMysqlDatetime(input.resolvedAt) : outcomeAt;

  const existing = await getSignalOutcomeBySignalId(input.signalId);
  if (existing) return { inserted: false, row: existing };

  const result = await db.query(
    `INSERT INTO q365_signal_outcomes
       (signal_id, strategy_id, symbol, outcome, outcome_at,
        days_held, max_gain_pct, candle_check_count, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.signalId,
      input.strategyId,
      input.symbol,
      input.outcome,
      outcomeAt,
      input.daysHeld,
      input.maxGainPct ?? null,
      input.candleCheckCount ?? 0,
      resolvedAt,
    ],
  );

  const affected = Number(result.affectedRows ?? 0);
  if (affected === 0) return { inserted: false, row: null };

  const row = await getSignalOutcomeBySignalId(input.signalId);
  return { inserted: true, row };
}

export async function getSignalOutcomeBySignalId(
  signalId: number,
): Promise<SignalOutcomeLedgerRow | null> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM q365_signal_outcomes
     WHERE signal_id = ? AND ${LEDGER_WHERE}
     LIMIT 1`,
    [signalId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listSignalOutcomes(
  filter: SignalOutcomeLedgerListFilter = {},
): Promise<SignalOutcomeLedgerRow[]> {
  const clauses = [LEDGER_WHERE];
  const params: unknown[] = [];

  if (filter.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(filter.strategyId);
  }
  if (filter.outcome) {
    clauses.push('outcome = ?');
    params.push(filter.outcome);
  }
  if (filter.symbol) {
    clauses.push('symbol = ?');
    params.push(filter.symbol.toUpperCase());
  }
  if (filter.since) {
    clauses.push('outcome_at >= ?');
    params.push(toMysqlDatetime(filter.since));
  }

  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 20_000);
  params.push(limit);

  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM q365_signal_outcomes
     WHERE ${clauses.join(' AND ')}
     ORDER BY outcome_at DESC
     LIMIT ?`,
    params,
  );
  return rows.map(mapRow);
}

export async function getExistingSignalOutcomeIds(
  signalIds: number[],
): Promise<Set<number>> {
  if (!signalIds.length) return new Set();
  const placeholders = signalIds.map(() => '?').join(',');
  const { rows } = await db.query<{ signal_id: number }>(
    `SELECT signal_id FROM q365_signal_outcomes
     WHERE signal_id IN (${placeholders}) AND ${LEDGER_WHERE}`,
    signalIds,
  );
  return new Set(rows.map((r) => Number(r.signal_id)));
}

export async function getSignalOutcomeCoverage(
  since?: string | Date,
): Promise<SignalOutcomeCoverage> {
  const params: unknown[] = [];
  let sinceClause = '';
  if (since) {
    sinceClause = 'AND s.generated_at >= ?';
    params.push(toMysqlDatetime(since));
  }

  const { rows } = await db.query<{ total: number; with_outcome: number }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(o.id) AS with_outcome
     FROM q365_signals s
     LEFT JOIN q365_signal_outcomes o
       ON o.signal_id = s.id
      AND o.strategy_id IS NOT NULL
      AND o.outcome IS NOT NULL
      AND o.outcome_at IS NOT NULL
     WHERE 1=1 ${sinceClause}`,
    params,
  );

  const total = Number(rows[0]?.total ?? 0);
  const withOutcome = Number(rows[0]?.with_outcome ?? 0);

  return {
    totalSignals: total,
    withOutcome,
    withoutOutcome: total - withOutcome,
    coveragePct: total > 0
      ? Math.round((withOutcome / total) * 10_000) / 100
      : null,
  };
}
