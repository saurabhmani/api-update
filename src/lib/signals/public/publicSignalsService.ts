// Public Signals API — query parsing, validation, orchestration

import type { NextRequest } from 'next/server';
import { NotFoundError, ValidationError } from '@/lib/errors';
import {
  aggregatePublicSignalsSummary,
  countPublicSignals,
  listPublicSignals,
} from './publicSignalsRepository';
import type {
  PublicSignalsFeedResult,
  PublicSignalsQuery,
  PublicSignalSortField,
} from './publicSignalsTypes';
import { PUBLIC_SIGNAL_OUTCOMES, PUBLIC_SIGNAL_SORT_FIELDS } from './publicSignalsTypes';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function parseSort(raw: string | null): { sort: PublicSignalSortField; sortDir: 'asc' | 'desc' } {
  if (!raw) return { sort: 'created_at', sortDir: 'desc' };
  const [field, dir] = raw.split(':');
  const sort = PUBLIC_SIGNAL_SORT_FIELDS.includes(field as PublicSignalSortField)
    ? (field as PublicSignalSortField)
    : 'created_at';
  const sortDir = dir === 'asc' ? 'asc' : 'desc';
  return { sort, sortDir };
}

export function parsePublicSignalsQuery(req: NextRequest): PublicSignalsQuery {
  const sp = req.nextUrl.searchParams;
  const page = clampInt(sp.get('page'), 1, 10_000, 1);
  const limit = clampInt(sp.get('limit'), 1, 100, 50);

  const fromDate = sp.get('from_date')?.trim() || undefined;
  const toDate = sp.get('to_date')?.trim() || undefined;
  if (fromDate && !DATE_RE.test(fromDate)) {
    throw new ValidationError('from_date must be YYYY-MM-DD');
  }
  if (toDate && !DATE_RE.test(toDate)) {
    throw new ValidationError('to_date must be YYYY-MM-DD');
  }
  if (fromDate && toDate && fromDate > toDate) {
    throw new ValidationError('from_date must be on or before to_date');
  }

  const outcome = sp.get('outcome')?.trim().toUpperCase() || undefined;
  if (outcome && !PUBLIC_SIGNAL_OUTCOMES.includes(outcome as typeof PUBLIC_SIGNAL_OUTCOMES[number])) {
    throw new ValidationError(`outcome must be one of: ${PUBLIC_SIGNAL_OUTCOMES.join(', ')}`);
  }

  const strategy = sp.get('strategy')?.trim() || undefined;
  const symbol = sp.get('symbol')?.trim().toUpperCase() || undefined;
  const { sort, sortDir } = parseSort(sp.get('sort'));

  return {
    page,
    limit,
    strategy,
    symbol,
    outcome,
    fromDate,
    toDate,
    sort,
    sortDir,
  };
}

export function buildPublicSignalsCacheKey(query: PublicSignalsQuery): string {
  return [
    'public:signals',
    `page:${query.page}`,
    `limit:${query.limit}`,
    `strategy:${query.strategy ?? ''}`,
    `symbol:${query.symbol ?? ''}`,
    `outcome:${query.outcome ?? ''}`,
    `from:${query.fromDate ?? ''}`,
    `to:${query.toDate ?? ''}`,
    `sort:${query.sort}:${query.sortDir}`,
  ].join(':');
}

export async function getPublicSignalsFeed(
  query: PublicSignalsQuery,
): Promise<PublicSignalsFeedResult> {
  const total = await countPublicSignals(query);
  const maxPage = total > 0 ? Math.ceil(total / query.limit) : 1;
  if (query.page > maxPage && total > 0) {
    throw new NotFoundError('Page', query.page);
  }

  const [data, summary] = await Promise.all([
    listPublicSignals(query),
    aggregatePublicSignalsSummary(query),
  ]);

  return {
    data,
    page: query.page,
    total,
    summary,
    win_rate: summary.win_rate,
  };
}
