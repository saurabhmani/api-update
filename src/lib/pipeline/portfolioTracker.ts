// ════════════════════════════════════════════════════════════════
//  portfolioTracker — event-driven ledger of cash, positions and
//  realized / unrealized P&L. Consumes two event streams:
//
//    1. Fills       → onFill({symbol, side, qty, price})
//    2. Live ticks  → onPriceUpdate(symbol, price)  (mark-to-market)
//
//  State is process-local and persisted to Redis under
//  `portfolio:state` (HASH) so a restart rehydrates cash + positions
//  without replaying the whole fills log.
//
//  No DB, no REST. The tracker never fetches prices — it only
//  reacts to ticks the caller hands it, satisfying the "no REST
//  polling for prices" constraint.
// ════════════════════════════════════════════════════════════════

import type Redis from 'ioredis';
import { createRedis } from './streams';

export interface Position {
  symbol:    string;
  quantity:  number;   // signed: + long, − short
  avgPrice:  number;
  lastPrice: number;
}

export interface Fill {
  symbol: string;
  side:   'BUY' | 'SELL';
  qty:    number;
  price:  number;
  ts:     number;
}

export interface PortfolioSnapshot {
  cash:              number;
  equity:            number;            // cash + sum(unrealized per position)
  realizedPnlToday:  number;
  realizedPnlTotal:  number;
  grossExposure:     number;
  openPositionCount: number;
  positions:         Record<string, Position>;
}

const REDIS_KEY = 'portfolio:state';
const GLOBAL_KEY = '__q365_portfolio_tracker__';

interface TrackerState {
  cash:              number;
  realizedPnlToday:  number;
  realizedPnlTotal:  number;
  positions:         Map<string, Position>;
  dayStamp:          string;
  redis:             Redis | null;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function getState(): TrackerState {
  const g = globalThis as unknown as Record<string, TrackerState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cash:             Number(process.env.INITIAL_CAPITAL ?? 1_000_000),
      realizedPnlToday: 0,
      realizedPnlTotal: 0,
      positions:        new Map(),
      dayStamp:         todayStamp(),
      redis:            null,
    };
  }
  return g[GLOBAL_KEY]!;
}

function rollDayIfNeeded(s: TrackerState): void {
  const today = todayStamp();
  if (today !== s.dayStamp) {
    s.realizedPnlToday = 0;
    s.dayStamp = today;
  }
}

// ── Public API ────────────────────────────────────────────────

export async function loadPortfolio(): Promise<void> {
  const s = getState();
  if (!s.redis) s.redis = createRedis();
  const h = await s.redis.hgetall(REDIS_KEY);
  if (!h || Object.keys(h).length === 0) return;
  if (h.cash)             s.cash             = Number(h.cash);
  if (h.realizedToday)    s.realizedPnlToday = Number(h.realizedToday);
  if (h.realizedTotal)    s.realizedPnlTotal = Number(h.realizedTotal);
  if (h.dayStamp)         s.dayStamp         = h.dayStamp;
  if (h.positions) {
    try {
      const arr = JSON.parse(h.positions) as Position[];
      s.positions = new Map(arr.map((p) => [p.symbol, p]));
    } catch { /* ignore malformed */ }
  }
}

export async function persistPortfolio(): Promise<void> {
  const s = getState();
  if (!s.redis) s.redis = createRedis();
  await s.redis.hset(REDIS_KEY, {
    cash:          s.cash,
    realizedToday: s.realizedPnlToday,
    realizedTotal: s.realizedPnlTotal,
    dayStamp:      s.dayStamp,
    positions:     JSON.stringify([...s.positions.values()]),
  });
}

export function onFill(fill: Fill): void {
  const s = getState();
  rollDayIfNeeded(s);
  const existing = s.positions.get(fill.symbol);
  const signedQty = fill.side === 'BUY' ? fill.qty : -fill.qty;

  if (!existing) {
    s.positions.set(fill.symbol, {
      symbol:    fill.symbol,
      quantity:  signedQty,
      avgPrice:  fill.price,
      lastPrice: fill.price,
    });
    s.cash -= fill.price * signedQty;
    return;
  }

  const newQty = existing.quantity + signedQty;
  const sameDirection = Math.sign(existing.quantity) === Math.sign(signedQty);

  if (sameDirection || existing.quantity === 0) {
    // Averaging in — weighted average entry.
    const totalCost = existing.avgPrice * Math.abs(existing.quantity) + fill.price * Math.abs(signedQty);
    existing.avgPrice = totalCost / Math.abs(newQty || 1);
    existing.quantity = newQty;
  } else {
    // Reducing / flipping — realize P&L on the closed portion.
    const closedQty = Math.min(Math.abs(existing.quantity), Math.abs(signedQty));
    const pnlPerShare = (fill.price - existing.avgPrice) * Math.sign(existing.quantity);
    const realized = pnlPerShare * closedQty;
    s.realizedPnlToday += realized;
    s.realizedPnlTotal += realized;
    existing.quantity = newQty;
    if (newQty !== 0 && !sameDirection) {
      existing.avgPrice = fill.price; // flipped side, reset basis
    }
  }

  existing.lastPrice = fill.price;
  s.cash -= fill.price * signedQty;

  if (existing.quantity === 0) s.positions.delete(fill.symbol);
}

export function onPriceUpdate(symbol: string, price: number): void {
  const p = getState().positions.get(symbol);
  if (p) p.lastPrice = price;
}

export function snapshot(): PortfolioSnapshot {
  const s = getState();
  rollDayIfNeeded(s);
  let unrealized = 0;
  let gross = 0;
  const positions: Record<string, Position> = {};
  for (const p of s.positions.values()) {
    positions[p.symbol] = p;
    unrealized += (p.lastPrice - p.avgPrice) * p.quantity;
    gross += Math.abs(p.quantity * p.lastPrice);
  }
  return {
    cash:              s.cash,
    equity:            s.cash + unrealized,
    realizedPnlToday:  s.realizedPnlToday,
    realizedPnlTotal:  s.realizedPnlTotal,
    grossExposure:     gross,
    openPositionCount: s.positions.size,
    positions,
  };
}
