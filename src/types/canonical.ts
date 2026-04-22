// ════════════════════════════════════════════════════════════════
//  Canonical Data Types — Single source of truth for all entities
//
//  Every engine must use the same IDs, timestamps, and structures.
//  These types map 1:1 to the canonical DB schema.
// ════════════════════════════════════════════════════════════════

// ── Instrument ──────────────────────────────────────────────────
export interface CanonicalInstrument {
  id: number;
  ticker: string;           // tradingsymbol
  exchange: string;
  isin: string | null;
  name: string | null;
  sectorId: number | null;
  industry: string | null;
  assetType: string;        // EQ, FUT, OPT, IDX
  currency: string;
  status: 'active' | 'inactive' | 'delisted';
  createdAt: string;
  updatedAt: string;
}

// ── Price ───────────────────────────────────────────────────────
export interface CanonicalPrice {
  id: number;
  instrumentId: number;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;           // kite | nse | yahoo | manual
}

// ── Portfolio ───────────────────────────────────────────────────
export interface CanonicalPortfolio {
  id: number;
  name: string;
  ownerType: 'individual' | 'institutional' | 'model';
  baseCurrency: string;
  benchmarkId: number | null;
  strategyType: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Position ────────────────────────────────────────────────────
export interface CanonicalPosition {
  id: number;
  portfolioId: number;
  instrumentId: number;
  ticker: string;
  quantity: number;
  avgCost: number;
  marketValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  asOf: string;             // snapshot timestamp
}

// ── Transaction ─────────────────────────────────────────────────
export interface CanonicalTransaction {
  id: number;
  portfolioId: number;
  instrumentId: number;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fees: number;
  executedAt: string;
  source: string;           // manual | kite | broker_api
}

// ── Benchmark ───────────────────────────────────────────────────
export interface CanonicalBenchmark {
  id: number;
  name: string;
  ticker: string;
  assetType: string;        // index | etf | composite
}

// ── Sector ──────────────────────────────────────────────────────
export interface CanonicalSector {
  id: number;
  name: string;
}

// ── Factor ──────────────────────────────────────────────────────
export interface CanonicalFactor {
  id: number;
  name: string;
  category: string;         // style | macro | technical | fundamental
}

// ── Mapping helpers ─────────────────────────────────────────────

/** Map a DB instrument row to canonical shape */
export function toCanonicalInstrument(row: Record<string, any>): CanonicalInstrument {
  return {
    id: row.id,
    ticker: row.tradingsymbol ?? row.ticker,
    exchange: row.exchange,
    isin: row.isin ?? null,
    name: row.name ?? null,
    sectorId: row.sector_id ?? null,
    industry: row.industry ?? null,
    assetType: row.asset_type ?? row.instrument_type ?? 'EQ',
    currency: row.currency ?? 'INR',
    status: row.is_active === 0 ? 'inactive' : (row.status ?? 'active'),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

export function toCanonicalPrice(row: Record<string, any>): CanonicalPrice {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    timestamp: row.ts ?? row.timestamp,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
    source: row.source ?? 'unknown',
  };
}

export function toCanonicalPortfolio(row: Record<string, any>): CanonicalPortfolio {
  return {
    id: row.id,
    name: row.name,
    ownerType: row.owner_type ?? 'individual',
    baseCurrency: row.base_currency ?? 'INR',
    benchmarkId: row.benchmark_id ?? null,
    strategyType: row.strategy_type ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

export function toCanonicalPosition(row: Record<string, any>): CanonicalPosition {
  const qty = Number(row.quantity ?? 0);
  const avgCost = Number(row.avg_cost ?? row.buy_price ?? 0);
  const mktVal = Number(row.market_value ?? (qty * Number(row.current_price ?? avgCost)));
  const unrealized = Number(row.unrealized_pnl ?? (mktVal - qty * avgCost));
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id ?? 0,
    ticker: row.tradingsymbol ?? row.ticker ?? '',
    quantity: qty,
    avgCost,
    marketValue: mktVal,
    unrealizedPnl: unrealized,
    realizedPnl: Number(row.realized_pnl ?? 0),
    asOf: row.as_of ?? row.updated_at ?? new Date().toISOString(),
  };
}

export function toCanonicalTransaction(row: Record<string, any>): CanonicalTransaction {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    instrumentId: row.instrument_id ?? 0,
    side: row.side ?? (row.quantity > 0 ? 'buy' : 'sell'),
    quantity: Math.abs(Number(row.quantity)),
    price: Number(row.price ?? row.entry_price ?? 0),
    fees: Number(row.fees ?? 0),
    executedAt: row.executed_at ?? row.entry_date ?? row.created_at,
    source: row.source ?? 'manual',
  };
}

export function toCanonicalBenchmark(row: Record<string, any>): CanonicalBenchmark {
  return {
    id: row.id,
    name: row.name,
    ticker: row.ticker,
    assetType: row.asset_type ?? 'index',
  };
}

export function toCanonicalSector(row: Record<string, any>): CanonicalSector {
  return {
    id: row.id,
    name: row.name,
  };
}

export function toCanonicalFactor(row: Record<string, any>): CanonicalFactor {
  return {
    id: row.id,
    name: row.name,
    category: row.category ?? 'style',
  };
}
