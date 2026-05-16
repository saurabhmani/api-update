// ════════════════════════════════════════════════════════════════
//  backtestEngine — replays a tick sequence through a strategy,
//  risk manager and a simulated execution layer, producing trades
//  and a P&L summary. Same types as the live pipeline so a
//  strategy that backtests well can be dropped into StrategyWorker
//  unchanged.
//
//  Tick source
//  ───────────
//    - `backtestFromRedis()` reads historical entries from
//      market_ticks via XRANGE (the same stream the live pipeline
//      writes to). No external data source required.
//    - `backtestFromArray()` takes an in-memory array for unit
//      tests.
// ════════════════════════════════════════════════════════════════

import {
  MARKET_TICKS_STREAM,
  createRedis,
  fieldsToObject,
  parseTickEntry,
  type TickStreamEntry,
  type SignalStreamEntry,
} from './streams';
import { evaluateRisk, DEFAULT_RISK_CONFIG, type RiskConfig, type RiskVerdict } from './riskManager';
import type { StrategyFn } from './strategyWorker';

export interface BacktestTrade {
  signal:    SignalStreamEntry;
  verdict:   RiskVerdict;
  exit:      { price: number; ts: number; reason: 'TARGET' | 'STOP' | 'TIMEOUT' } | null;
  pnl:       number;
}

export interface BacktestResult {
  trades:       BacktestTrade[];
  totalTrades:  number;
  wins:         number;
  losses:       number;
  winRate:      number;
  grossPnl:     number;
  maxDrawdown:  number;
  avgHoldMs:    number;
}

export interface BacktestOptions {
  strategy:       StrategyFn;
  initialCapital: number;
  risk?:          RiskConfig;
  /** Force-close any open trade after this many ms from entry. */
  timeoutMs?:     number;
}

interface OpenTrade {
  signal:  SignalStreamEntry;
  verdict: RiskVerdict;
  openedAt: number;
}

async function runLoop(
  ticks: AsyncIterable<TickStreamEntry>,
  opts: BacktestOptions,
): Promise<BacktestResult> {
  const risk = opts.risk ?? DEFAULT_RISK_CONFIG;
  const trades: BacktestTrade[] = [];
  const openBySymbol = new Map<string, OpenTrade>();
  let equity = opts.initialCapital;
  let peakEquity = equity;
  let maxDD = 0;
  const timeout = opts.timeoutMs ?? 6 * 60 * 60_000;

  // Cheap portfolio stub for the risk manager — the full tracker
  // is overkill for a replay.
  const portfolioStub = {
    cash:              equity,
    equity,
    realizedPnlToday:  0,
    realizedPnlTotal:  0,
    grossExposure:     0,
    openPositionCount: 0,
    positions:         {},
  };

  for await (const tick of ticks) {
    // 1. Check open trade for exit.
    const open = openBySymbol.get(tick.symbol);
    if (open) {
      const { signal } = open;
      const isLong = signal.direction === 'BUY';
      const hitTarget = isLong ? tick.ltp >= signal.target : tick.ltp <= signal.target;
      const hitStop   = isLong ? tick.ltp <= signal.stop   : tick.ltp >= signal.stop;
      const expired   = tick.ts - open.openedAt > timeout;

      if (hitTarget || hitStop || expired) {
        const exitPrice = hitTarget ? signal.target : hitStop ? signal.stop : tick.ltp;
        const qty = open.verdict.sizedQuantity ?? 0;
        const pnl = (exitPrice - signal.entry) * qty * (isLong ? 1 : -1);
        equity += pnl;
        peakEquity = Math.max(peakEquity, equity);
        maxDD = Math.max(maxDD, peakEquity - equity);

        trades.push({
          signal,
          verdict: open.verdict,
          exit: {
            price:  exitPrice,
            ts:     tick.ts,
            reason: hitTarget ? 'TARGET' : hitStop ? 'STOP' : 'TIMEOUT',
          },
          pnl,
        });
        openBySymbol.delete(tick.symbol);
        portfolioStub.openPositionCount = openBySymbol.size;
        portfolioStub.cash += pnl;
        portfolioStub.equity = equity;
      }
    }

    // 2. Evaluate new signal from strategy.
    const sig = await opts.strategy(tick);
    if (!sig) continue;
    if (openBySymbol.has(tick.symbol)) continue;

    const verdict = evaluateRisk(sig, portfolioStub, risk);
    if (!verdict.ok) continue;

    openBySymbol.set(tick.symbol, { signal: sig, verdict, openedAt: tick.ts });
    portfolioStub.openPositionCount = openBySymbol.size;
  }

  // 3. Close any still-open trades at the last seen price.
  for (const open of openBySymbol.values()) {
    const qty = open.verdict.sizedQuantity ?? 0;
    const isLong = open.signal.direction === 'BUY';
    const pnl = (open.signal.entry - open.signal.entry) * qty * (isLong ? 1 : -1);
    trades.push({ signal: open.signal, verdict: open.verdict, exit: null, pnl });
  }

  const wins  = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const grossPnl = trades.reduce((n, t) => n + t.pnl, 0);
  const totalHold = trades.reduce((n, t) => n + (t.exit ? t.exit.ts - t.signal.ts : 0), 0);

  return {
    trades,
    totalTrades: trades.length,
    wins,
    losses,
    winRate:     trades.length > 0 ? wins / trades.length : 0,
    grossPnl,
    maxDrawdown: maxDD,
    avgHoldMs:   trades.length > 0 ? totalHold / trades.length : 0,
  };
}

export async function backtestFromArray(
  ticks: ReadonlyArray<TickStreamEntry>,
  opts: BacktestOptions,
): Promise<BacktestResult> {
  async function* iter(): AsyncGenerator<TickStreamEntry> {
    for (const t of ticks) yield t;
  }
  return runLoop(iter(), opts);
}

export interface RedisBacktestRange {
  from: string; // stream id ('-' = earliest)
  to:   string; // stream id ('+' = latest)
  symbol?: string; // optional filter
}

export async function backtestFromRedis(
  range: RedisBacktestRange,
  opts: BacktestOptions,
): Promise<BacktestResult> {
  const r = createRedis();
  try {
    async function* iter(): AsyncGenerator<TickStreamEntry> {
      let cursor = range.from;
      while (true) {
        const batch = await r.xrange(MARKET_TICKS_STREAM, cursor, range.to, 'COUNT', 1000) as Array<[string, string[]]>;
        if (!batch || batch.length === 0) return;
        for (const [id, flat] of batch) {
          const tick = parseTickEntry(fieldsToObject(flat));
          if (!tick) continue;
          if (range.symbol && tick.symbol !== range.symbol) continue;
          yield tick;
          cursor = id;
        }
        if (batch.length < 1000) return;
        // Move cursor forward one step so XRANGE is exclusive.
        cursor = `(${cursor}`;
      }
    }
    return await runLoop(iter(), opts);
  } finally {
    await r.quit().catch(() => { /* noop */ });
  }
}
