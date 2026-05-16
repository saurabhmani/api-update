// ════════════════════════════════════════════════════════════════
//  Canonical Data Service — Read-only access to canonical entities
//
//  Single source of truth for instruments, prices, portfolios,
//  positions, transactions, benchmarks, sectors, and factors.
//  Every engine should consume data through this service.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  CanonicalInstrument,
  CanonicalPrice,
  CanonicalPortfolio,
  CanonicalPosition,
  CanonicalTransaction,
  CanonicalBenchmark,
  CanonicalSector,
  CanonicalFactor,
  toCanonicalInstrument,
  toCanonicalPrice,
  toCanonicalPortfolio,
  toCanonicalPosition,
  toCanonicalTransaction,
  toCanonicalBenchmark,
  toCanonicalSector,
  toCanonicalFactor,
} from '@/types/canonical';

const log = logger.child({ service: 'canonicalData' });

// ── Instruments ─────────────────────────────────────────────────

export async function getInstruments(opts?: {
  exchange?: string;
  assetType?: string;
  sectorId?: number;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<CanonicalInstrument[]> {
  const clauses: string[] = [];
  const params: any[] = [];

  if (opts?.exchange) {
    clauses.push('i.exchange = ?');
    params.push(opts.exchange);
  }
  if (opts?.assetType) {
    clauses.push('i.asset_type = ?');
    params.push(opts.assetType);
  }
  if (opts?.sectorId) {
    clauses.push('i.sector_id = ?');
    params.push(opts.sectorId);
  }
  if (opts?.activeOnly !== false) {
    clauses.push('i.is_active = 1');
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts?.limit ?? 500;
  const offset = opts?.offset ?? 0;

  const { rows } = await db.query(
    `SELECT i.*, s.id AS sector_id_resolved, s.name AS sector_name
     FROM instruments i
     LEFT JOIN sectors s ON i.sector_id = s.id
     ${where}
     ORDER BY i.tradingsymbol
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map(toCanonicalInstrument);
}

export async function getInstrumentById(id: number): Promise<CanonicalInstrument | null> {
  const { rows } = await db.query(
    'SELECT * FROM instruments WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? toCanonicalInstrument(rows[0]) : null;
}

export async function getInstrumentByTicker(ticker: string, exchange = 'NSE'): Promise<CanonicalInstrument | null> {
  const { rows } = await db.query(
    'SELECT * FROM instruments WHERE tradingsymbol = ? AND exchange = ? LIMIT 1',
    [ticker, exchange],
  );
  return rows.length > 0 ? toCanonicalInstrument(rows[0]) : null;
}

// ── Prices ──────────────────────────────────────────────────────

export async function getPrices(opts: {
  instrumentId?: number;
  ticker?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<CanonicalPrice[]> {
  const clauses: string[] = ["c.candle_type = 'eod'", "c.interval_unit = '1day'"];
  const params: any[] = [];

  if (opts.instrumentId) {
    // join instruments to resolve
    clauses.push('i.id = ?');
    params.push(opts.instrumentId);
  } else if (opts.ticker) {
    clauses.push('c.instrument_key LIKE ?');
    params.push(`%${opts.ticker}%`);
  }
  if (opts.from) {
    clauses.push('c.ts >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push('c.ts <= ?');
    params.push(opts.to);
  }

  const where = `WHERE ${clauses.join(' AND ')}`;
  const limit = opts.limit ?? 250;

  const { rows } = await db.query(
    `SELECT c.id, i.id AS instrument_id, c.ts AS timestamp,
            c.open, c.high, c.low, c.close, c.volume,
            'candle_db' AS source
     FROM candles c
     LEFT JOIN instruments i ON c.instrument_key = i.instrument_key
     ${where}
     ORDER BY c.ts DESC
     LIMIT ?`,
    [...params, limit],
  );
  return rows.map(toCanonicalPrice);
}

// ── Portfolios ──────────────────────────────────────────────────

export async function getPortfolios(userId?: number): Promise<CanonicalPortfolio[]> {
  const where = userId ? 'WHERE p.user_id = ?' : '';
  const params = userId ? [userId] : [];

  const { rows } = await db.query(
    `SELECT p.*, b.ticker AS benchmark_ticker, b.name AS benchmark_name
     FROM portfolios p
     LEFT JOIN benchmarks b ON p.benchmark_id = b.id
     ${where}
     ORDER BY p.name`,
    params,
  );
  return rows.map(toCanonicalPortfolio);
}

export async function getPortfolioById(id: number): Promise<CanonicalPortfolio | null> {
  const { rows } = await db.query(
    'SELECT * FROM portfolios WHERE id = ?',
    [id],
  );
  return rows.length > 0 ? toCanonicalPortfolio(rows[0]) : null;
}

// ── Positions ───────────────────────────────────────────────────

export async function getPositions(portfolioId: number): Promise<CanonicalPosition[]> {
  const { rows } = await db.query(
    `SELECT pp.*, i.id AS instrument_id_resolved
     FROM portfolio_positions pp
     LEFT JOIN instruments i ON pp.instrument_id = i.id
     WHERE pp.portfolio_id = ?
     ORDER BY pp.tradingsymbol`,
    [portfolioId],
  );
  return rows.map((r: any) => {
    r.instrument_id = r.instrument_id ?? r.instrument_id_resolved ?? 0;
    return toCanonicalPosition(r);
  });
}

// ── Transactions ────────────────────────────────────────────────

export async function getTransactions(opts: {
  portfolioId?: number;
  ticker?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<CanonicalTransaction[]> {
  const clauses: string[] = [];
  const params: any[] = [];

  if (opts.portfolioId) {
    clauses.push('t.portfolio_id = ?');
    params.push(opts.portfolioId);
  }
  if (opts.ticker) {
    clauses.push('t.ticker = ?');
    params.push(opts.ticker);
  }
  if (opts.from) {
    clauses.push('t.executed_at >= ?');
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push('t.executed_at <= ?');
    params.push(opts.to);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ?? 500;

  const { rows } = await db.query(
    `SELECT t.*
     FROM transactions t
     ${where}
     ORDER BY t.executed_at DESC
     LIMIT ?`,
    [...params, limit],
  );
  return rows.map(toCanonicalTransaction);
}

// ── Benchmarks ──────────────────────────────────────────────────

export async function getBenchmarks(): Promise<CanonicalBenchmark[]> {
  const { rows } = await db.query('SELECT * FROM benchmarks ORDER BY name');
  return rows.map(toCanonicalBenchmark);
}

export async function getBenchmarkById(id: number): Promise<CanonicalBenchmark | null> {
  const { rows } = await db.query('SELECT * FROM benchmarks WHERE id = ?', [id]);
  return rows.length > 0 ? toCanonicalBenchmark(rows[0]) : null;
}

// ── Sectors ─────────────────────────────────────────────────────

export async function getSectors(): Promise<CanonicalSector[]> {
  const { rows } = await db.query('SELECT * FROM sectors ORDER BY name');
  return rows.map(toCanonicalSector);
}

// ── Factors ─────────────────────────────────────────────────────

export async function getFactors(category?: string): Promise<CanonicalFactor[]> {
  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];
  const { rows } = await db.query(
    `SELECT * FROM factors ${where} ORDER BY category, name`,
    params,
  );
  return rows.map(toCanonicalFactor);
}
