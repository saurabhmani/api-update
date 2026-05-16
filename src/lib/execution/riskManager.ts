// ════════════════════════════════════════════════════════════════
//  riskManager — pre-trade gate for the execution engine
//
//  Enforces three hard rules before any order leaves the process:
//
//    1. MAX_OPEN_TRADES      — reject if portfolio is already at
//                              its concurrent position cap
//    2. NO duplicate symbol  — reject if we already hold (or just
//                              sent) an order for the same symbol
//    3. Per-symbol cooldown  — reject if we placed an order for
//                              this symbol within the last N sec
//
//  All state is in-process. If you run multi-instance (PM2
//  cluster, k8s replicas) you MUST move this to Redis or a shared
//  DB row — otherwise each replica enforces its own budget and
//  you'll end up 5×N open positions. Single-process is fine for
//  dev and small deployments.
//
//  The manager does NOT place orders. It only decides whether an
//  incoming signal is allowed to proceed. The caller is expected
//  to call `recordFill()` / `recordClose()` on order lifecycle
//  transitions so state stays accurate.
// ════════════════════════════════════════════════════════════════

const MAX_OPEN_TRADES =
  Number(process.env.RISK_MAX_OPEN_TRADES) || 5;
const COOLDOWN_MS =
  (Number(process.env.RISK_COOLDOWN_SEC) || 60) * 1000;

export interface OpenPosition {
  symbol: string;
  type: 'BUY' | 'SELL';
  entryPrice: number;
  qty: number;
  openedAt: number;
}

export interface RiskCheckResult {
  allow: boolean;
  reason?: string;
}

// Per-symbol cooldown floor. An entry exists for every symbol we
// have recently *attempted* (not just filled) — we want the
// cooldown to fire even on rejected orders so a flapping signal
// can't thrash the broker.
const cooldownBySymbol = new Map<string, number>();

// Currently open positions, keyed by symbol so the duplicate
// check is O(1). Multi-leg strategies (pairs, spreads) would
// need a richer key — not this file's problem.
const openPositions = new Map<string, OpenPosition>();

// ── Public API ────────────────────────────────────────────────

export function checkSignal(
  symbol: string,
  type: 'BUY' | 'SELL',
): RiskCheckResult {
  const now = Date.now();

  // Rule 1: duplicate symbol check — reject even if cooldown has
  // passed, because the symbol is still open from a prior fill.
  if (openPositions.has(symbol)) {
    return { allow: false, reason: `already open: ${symbol}` };
  }

  // Rule 2: portfolio cap
  if (openPositions.size >= MAX_OPEN_TRADES) {
    return {
      allow: false,
      reason: `max open trades reached (${openPositions.size}/${MAX_OPEN_TRADES})`,
    };
  }

  // Rule 3: per-symbol cooldown
  const cooldownUntil = cooldownBySymbol.get(symbol) ?? 0;
  if (now < cooldownUntil) {
    const remainingSec = Math.ceil((cooldownUntil - now) / 1000);
    return {
      allow: false,
      reason: `cooldown active for ${symbol} (${remainingSec}s remaining)`,
    };
  }

  return { allow: true };
}

/**
 * Record that we attempted to send an order for this symbol.
 * Called BEFORE the HTTP request, so even if Kite rejects the
 * order we still enforce the cooldown — prevents a flapping
 * signal from hammering the broker API.
 */
export function recordAttempt(symbol: string): void {
  cooldownBySymbol.set(symbol, Date.now() + COOLDOWN_MS);
}

/**
 * Record a confirmed fill. Moves the symbol into the open
 * positions book so the duplicate guard kicks in.
 */
export function recordFill(position: OpenPosition): void {
  openPositions.set(position.symbol, position);
}

/**
 * Clear a symbol from the open positions book. Call from the
 * position-close handler (stop hit, target hit, manual exit).
 * The cooldown remains in effect until it naturally expires.
 */
export function recordClose(symbol: string): void {
  openPositions.delete(symbol);
}

export function getOpenPositions(): OpenPosition[] {
  return [...openPositions.values()];
}

export function getRiskStats() {
  return {
    openTrades: openPositions.size,
    maxOpenTrades: MAX_OPEN_TRADES,
    cooldownMs: COOLDOWN_MS,
    cooldownsActive: [...cooldownBySymbol.entries()]
      .filter(([, until]) => until > Date.now()).length,
  };
}

/** Testing / admin — wipes all state. Do NOT call from prod code. */
export function __resetRiskState(): void {
  cooldownBySymbol.clear();
  openPositions.clear();
}
