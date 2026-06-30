// Public Signals API — read-only MySQL queries

import { db } from '@/lib/db';
import type {
  PublicSignalRow,
  PublicSignalsQuery,
  PublicSignalsSummary,
} from './publicSignalsTypes';

const PUBLISHED_CLASSIFICATIONS = [
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
  'HIGH_CONVICTION_BUY',
  'VALID_BUY',
] as const;

const INVALIDATION_EXCLUSIONS = [
  'stop_loss_broken',
  'stop_loss_broken_confirmed',
  'target_reached',
  'target_already_reached',
  'engine_disagree',
  'live_rejected',
] as const;

const BASE_FROM = `
  FROM q365_signals s
  LEFT JOIN q365_signal_outcomes o ON s.id = o.signal_id
  LEFT JOIN (
    SELECT signal_id, MAX(target3) AS target3
    FROM q365_signal_trade_plans
    GROUP BY signal_id
  ) tp ON tp.signal_id = s.id
`;

const SELECT_COLUMNS = `
  SELECT
    s.id,
    s.symbol,
    COALESCE(o.strategy_id, s.signal_type) AS strategy_id,
    s.direction,
    s.entry_price,
    s.stop_loss,
    s.target1 AS target_1,
    s.target2 AS target_2,
    tp.target3 AS target_3,
    s.confidence_score,
    s.created_at,
    o.outcome,
    o.outcome_at,
    o.days_held,
    o.max_gain_pct
`;

/** Public DTO fields only — used by acceptance tests to verify no sensitive leaks. */
export const PUBLIC_SIGNAL_DTO_FIELDS = [
  'id', 'symbol', 'strategy_id', 'direction', 'entry_price', 'stop_loss',
  'target_1', 'target_2', 'target_3', 'confidence_score', 'created_at',
  'outcome', 'outcome_at', 'days_held', 'max_gain_pct',
] as const;

export interface PublicSignalsFilterClause {
  where: string;
  params: unknown[];
}

export function buildPublicSignalsFilter(query: PublicSignalsQuery): PublicSignalsFilterClause {
  const clauses: string[] = [
    `s.signal_status = 'APPROVED_SIGNAL'`,
    `UPPER(s.classification) IN (${PUBLISHED_CLASSIFICATIONS.map(() => '?').join(', ')})`,
    `(s.invalidation_reason IS NULL OR s.invalidation_reason NOT IN (${INVALIDATION_EXCLUSIONS.map(() => '?').join(', ')}))`,
  ];
  const params: unknown[] = [
    ...PUBLISHED_CLASSIFICATIONS,
    ...INVALIDATION_EXCLUSIONS,
  ];

  if (query.strategy) {
    clauses.push('(COALESCE(o.strategy_id, s.signal_type) = ?)');
    params.push(query.strategy);
  }
  if (query.symbol) {
    clauses.push('s.symbol = ?');
    params.push(query.symbol);
  }
  if (query.outcome) {
    clauses.push('o.outcome = ?');
    params.push(query.outcome);
  }
  if (query.fromDate) {
    clauses.push('s.created_at >= ?');
    params.push(`${query.fromDate} 00:00:00`);
  }
  if (query.toDate) {
    clauses.push('s.created_at <= ?');
    params.push(`${query.toDate} 23:59:59`);
  }

  return {
    where: `WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

function sortClause(query: PublicSignalsQuery): string {
  const field = query.sort === 'confidence_score' ? 's.confidence_score' : 's.created_at';
  const dir = query.sortDir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY ${field} ${dir}, s.id DESC`;
}

/** Format a DB timestamp as IST ISO-8601 (+05:30). */
export function formatPublicTimestamp(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    return formatIstFromUtcMs(v.getTime());
  }
  const s = String(v).trim();
  const mysqlWall = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  if (mysqlWall) {
    return `${mysqlWall[1]}T${mysqlWall[2]}+05:30`;
  }
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return formatIstFromUtcMs(d.getTime());
}

function formatIstFromUtcMs(utcMs: number): string {
  const istMs = utcMs + 5.5 * 3_600_000;
  const ist = new Date(istMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T`
    + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;
}

function mapRow(r: Record<string, unknown>): PublicSignalRow {
  return {
    id: Number(r.id),
    symbol: String(r.symbol ?? ''),
    strategy_id: String(r.strategy_id ?? ''),
    direction: String(r.direction ?? ''),
    entry_price: r.entry_price != null ? Number(r.entry_price) : null,
    stop_loss: r.stop_loss != null ? Number(r.stop_loss) : null,
    target_1: r.target_1 != null ? Number(r.target_1) : null,
    target_2: r.target_2 != null ? Number(r.target_2) : null,
    target_3: r.target_3 != null ? Number(r.target_3) : null,
    confidence_score: r.confidence_score != null ? Number(r.confidence_score) : null,
    created_at: formatPublicTimestamp(r.created_at),
    outcome: r.outcome != null ? String(r.outcome) : null,
    outcome_at: r.outcome_at != null ? formatPublicTimestamp(r.outcome_at) : null,
    days_held: r.days_held != null ? Number(r.days_held) : null,
    max_gain_pct: r.max_gain_pct != null ? Number(r.max_gain_pct) : null,
  };
}

export async function countPublicSignals(query: PublicSignalsQuery): Promise<number> {
  const { where, params } = buildPublicSignalsFilter(query);
  const { rows } = await db.query<{ total: number }>(
    `SELECT COUNT(DISTINCT s.id) AS total ${BASE_FROM} ${where}`,
    params,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function listPublicSignals(
  query: PublicSignalsQuery,
): Promise<PublicSignalRow[]> {
  const { where, params } = buildPublicSignalsFilter(query);
  const offset = (query.page - 1) * query.limit;
  const { rows } = await db.query<Record<string, unknown>>(
    `${SELECT_COLUMNS}
     ${BASE_FROM}
     ${where}
     ${sortClause(query)}
     LIMIT ? OFFSET ?`,
    [...params, query.limit, offset],
  );
  return rows.map(mapRow);
}

export async function aggregatePublicSignalsSummary(
  query: PublicSignalsQuery,
): Promise<PublicSignalsSummary> {
  const { where, params } = buildPublicSignalsFilter(query);

  const { rows } = await db.query<{
    total_signals: number;
    active_signals: number;
    signals_this_month: number;
    wins: number;
    losses: number;
    avg_confidence: number | null;
  }>(
    `SELECT
       COUNT(*) AS total_signals,
       SUM(CASE WHEN outcome = 'ACTIVE' OR outcome IS NULL THEN 1 ELSE 0 END) AS active_signals,
       SUM(CASE WHEN created_at >= DATE_FORMAT(CONVERT_TZ(NOW(), '+00:00', '+05:30'), '%Y-%m-01') THEN 1 ELSE 0 END) AS signals_this_month,
       SUM(CASE WHEN outcome IN ('T1_HIT', 'WIN') THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN outcome IN ('T1_HIT', 'SL_HIT', 'WIN', 'LOSS') THEN 1 ELSE 0 END) AS losses,
       AVG(confidence_score) AS avg_confidence
     FROM (
       SELECT DISTINCT
         s.id,
         s.created_at,
         s.confidence_score,
         o.outcome
       ${BASE_FROM}
       ${where}
     ) agg`,
    params,
  );

  const agg = rows[0] ?? {
    total_signals: 0,
    active_signals: 0,
    signals_this_month: 0,
    wins: 0,
    losses: 0,
    avg_confidence: null,
  };

  const wins = Number(agg.wins ?? 0);
  const losses = Number(agg.losses ?? 0);
  const winRate = losses > 0
    ? Math.round((wins / losses) * 10_000) / 100
    : 0;

  const bestStrategy = await fetchBestStrategy(query);

  return {
    win_rate: winRate,
    total_signals: Number(agg.total_signals ?? 0),
    active_signals: Number(agg.active_signals ?? 0),
    signals_this_month: Number(agg.signals_this_month ?? 0),
    best_strategy: bestStrategy,
    average_confidence: agg.avg_confidence != null
      ? Math.round(Number(agg.avg_confidence) * 100) / 100
      : 0,
  };
}

async function fetchBestStrategy(query: PublicSignalsQuery): Promise<string | null> {
  const { where, params } = buildPublicSignalsFilter(query);
  const minSamples = 5;

  const { rows } = await db.query<{ strategy_id: string; win_rate: number }>(
    `SELECT
       strategy_id,
       ROUND(SUM(CASE WHEN outcome IN ('T1_HIT', 'WIN') THEN 1 ELSE 0 END)
         / NULLIF(SUM(CASE WHEN outcome IN ('T1_HIT', 'SL_HIT', 'WIN', 'LOSS') THEN 1 ELSE 0 END), 0) * 100, 2) AS win_rate
     FROM (
       SELECT
         COALESCE(o.strategy_id, s.signal_type) AS strategy_id,
         o.outcome
       ${BASE_FROM}
       ${where}
     ) t
     WHERE strategy_id IS NOT NULL AND strategy_id <> ''
     GROUP BY strategy_id
     HAVING COUNT(*) >= ?
       AND SUM(CASE WHEN outcome IN ('T1_HIT', 'SL_HIT', 'WIN', 'LOSS') THEN 1 ELSE 0 END) > 0
     ORDER BY win_rate DESC, COUNT(*) DESC
     LIMIT 1`,
    [...params, minSamples],
  );

  return rows.length ? String(rows[0].strategy_id) : null;
}

/** SQL fragment for tests — confirms unpublished classifications are excluded. */
export const PUBLIC_SIGNALS_PUBLISHED_WHERE = buildPublicSignalsFilter({
  page: 1,
  limit: 50,
  sort: 'created_at',
  sortDir: 'desc',
}).where;
