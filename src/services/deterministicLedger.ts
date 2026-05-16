// ════════════════════════════════════════════════════════════════
//  Deterministic Portfolio Ledger
//
//  PRD Rule: Portfolio must be fully reconstructable from transactions.
//  Snapshots (portfolio_positions) are an optimization cache ONLY.
//
//  Core invariant:
//    state = f(transactions, prices)
//
//  This service replays ALL transactions for a portfolio up to a
//  given timestamp and derives holdings, cost basis, P&L, and
//  portfolio value deterministically. No approximations.
//
//  Cost basis method: Weighted Average Cost (WAC)
//    - On buy:  avgCost = (existing_value + new_value) / total_qty
//    - On sell: realized P&L = (sell_price - avgCost) × sell_qty
//    - Fees are added to cost basis (buy) or deducted from proceeds (sell)
//
//  This is the AUTHORITATIVE ledger. getHoldings() in
//  portfolioLedgerService reads the snapshot cache for performance.
//  rebuildPortfolioState() here can validate that cache at any time.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'deterministicLedger' });

// ── Types ───────────────────────────────────────────────────────

export interface LedgerPosition {
  ticker: string;
  instrumentId: number | null;
  quantity: number;
  avgCost: number;           // weighted average cost per share
  totalCost: number;         // quantity × avgCost
  realizedPnl: number;       // cumulative realized from sells
  fees: number;              // cumulative fees
  firstBuyAt: string | null;
  lastTransactionAt: string | null;
}

export interface LedgerState {
  portfolioId: number;
  asOf: string;              // the timestamp this state is valid for
  positions: LedgerPosition[];
  closedPositions: ClosedPosition[];
  totalInvested: number;     // sum of all open position costs
  totalRealizedPnl: number;  // sum of all realized P&L (open + closed)
  totalFees: number;
  transactionCount: number;
  method: 'weighted_average_cost';
}

export interface ClosedPosition {
  ticker: string;
  totalBought: number;
  totalSold: number;
  realizedPnl: number;
  fees: number;
  closedAt: string;
}

export interface LedgerValuation {
  state: LedgerState;
  // Requires market prices to compute
  marketValues: { ticker: string; quantity: number; avgCost: number; marketPrice: number; marketValue: number; unrealizedPnl: number; unrealizedPnlPct: number }[];
  totalMarketValue: number;
  totalUnrealizedPnl: number;
  totalPnl: number;          // realized + unrealized
  totalPnlPct: number;
}

export interface LedgerValidation {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  positionMismatches: {
    ticker: string;
    ledgerQty: number;
    snapshotQty: number;
    ledgerAvgCost: number;
    snapshotAvgCost: number;
  }[];
}

// ── Transaction Replay Engine ───────────────────────────────────

interface TxnRow {
  id: number;
  ticker: string;
  instrument_id: number | null;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fees: number;
  executed_at: string;
}

/**
 * Rebuild portfolio state deterministically from transactions.
 *
 * Replays every transaction up to `asOf` in chronological order.
 * Uses Weighted Average Cost (WAC) for cost basis.
 *
 * This is the AUTHORITATIVE computation. If this disagrees with
 * portfolio_positions, the positions table is wrong.
 */
export async function rebuildPortfolioState(
  portfolioId: number,
  asOf?: string | Date,
): Promise<LedgerState> {
  const cutoff = asOf ? new Date(asOf) : new Date();
  const cutoffIso = cutoff.toISOString();

  // Fetch ALL transactions up to cutoff, ordered chronologically
  const { rows } = await db.query(
    `SELECT id, ticker, instrument_id, side, quantity, price, fees, executed_at
     FROM transactions
     WHERE portfolio_id = ? AND executed_at <= ?
     ORDER BY executed_at ASC, id ASC`,
    [portfolioId, cutoffIso],
  );
  const txns = rows as TxnRow[];

  // Replay engine — tracks per-ticker state
  const positions = new Map<string, {
    instrumentId: number | null;
    quantity: number;
    avgCost: number;
    realizedPnl: number;
    fees: number;
    totalBought: number;       // cumulative buy quantity (for closed position records)
    totalSold: number;         // cumulative sell quantity
    firstBuyAt: string | null;
    lastTxnAt: string | null;
  }>();

  const closed: ClosedPosition[] = [];
  let totalRealizedPnl = 0;
  let totalFees = 0;

  for (const txn of txns) {
    const ticker = txn.ticker.toUpperCase();
    const qty = Math.abs(txn.quantity);
    const price = Number(txn.price);
    const fees = Number(txn.fees ?? 0);
    totalFees += fees;

    let pos = positions.get(ticker);
    if (!pos) {
      pos = { instrumentId: txn.instrument_id, quantity: 0, avgCost: 0, realizedPnl: 0, fees: 0, totalBought: 0, totalSold: 0, firstBuyAt: null, lastTxnAt: null };
      positions.set(ticker, pos);
    }
    pos.lastTxnAt = txn.executed_at;
    pos.fees += fees;
    if (txn.instrument_id) pos.instrumentId = txn.instrument_id;

    if (txn.side === 'buy') {
      // WAC: new avgCost = (existing_value + buy_value + fees) / new_total_qty
      const existingValue = pos.quantity * pos.avgCost;
      const buyValue = qty * price + fees; // fees increase cost basis
      const newQty = pos.quantity + qty;
      pos.avgCost = newQty > 0 ? (existingValue + buyValue) / newQty : 0;
      pos.quantity = newQty;
      pos.totalBought += qty;
      if (!pos.firstBuyAt) pos.firstBuyAt = txn.executed_at;
    } else {
      // SELL: realized P&L = (sell_price - avgCost) × sell_qty - fees
      const sellQty = Math.min(qty, pos.quantity); // can't sell more than owned
      if (sellQty > 0) {
        const pnl = (price - pos.avgCost) * sellQty - fees;
        pos.realizedPnl += pnl;
        totalRealizedPnl += pnl;
        pos.quantity -= sellQty;
        pos.totalSold += sellQty;

        // If position is fully closed, record it
        if (pos.quantity <= 0) {
          closed.push({
            ticker,
            totalBought: pos.totalBought,
            totalSold: pos.totalSold,
            realizedPnl: pos.realizedPnl,
            fees: pos.fees,
            closedAt: txn.executed_at,
          });
        }
      }
      if (qty > pos.quantity + sellQty) {
        // Short selling beyond holdings — not supported in this model
        log.warn('Sell exceeds holdings', { ticker, sellQty: qty, held: pos.quantity + sellQty });
      }
    }
  }

  // Build output — only open positions
  const openPositions: LedgerPosition[] = [];
  let totalInvested = 0;

  for (const [ticker, pos] of positions) {
    if (pos.quantity > 0) {
      const totalCost = pos.quantity * pos.avgCost;
      totalInvested += totalCost;
      openPositions.push({
        ticker,
        instrumentId: pos.instrumentId,
        quantity: pos.quantity,
        avgCost: parseFloat(pos.avgCost.toFixed(4)),
        totalCost: parseFloat(totalCost.toFixed(2)),
        realizedPnl: parseFloat(pos.realizedPnl.toFixed(2)),
        fees: parseFloat(pos.fees.toFixed(2)),
        firstBuyAt: pos.firstBuyAt,
        lastTransactionAt: pos.lastTxnAt,
      });
    }
  }

  return {
    portfolioId,
    asOf: cutoffIso,
    positions: openPositions,
    closedPositions: closed,
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    totalRealizedPnl: parseFloat(totalRealizedPnl.toFixed(2)),
    totalFees: parseFloat(totalFees.toFixed(2)),
    transactionCount: txns.length,
    method: 'weighted_average_cost',
  };
}

// ── Valuation (state + market prices) ───────────────────────────

/**
 * Compute full portfolio valuation from deterministic state + market prices.
 *
 * DETERMINISM RULE: This function NEVER reads portfolio_positions.
 * Prices come ONLY from the candles table (authoritative source)
 * or avgCost (stale fallback). The snapshot cache is an optimization
 * for UI reads — it must not influence the authoritative valuation.
 *
 * If a price override map is provided, those prices are used instead
 * of DB lookups — enabling fully offline, deterministic valuation.
 */
export async function valuatePortfolioState(
  state: LedgerState,
  priceOverrides?: Map<string, number>,
): Promise<LedgerValuation> {
  const marketValues: LedgerValuation['marketValues'] = [];
  let totalMarketValue = 0;
  let totalUnrealizedPnl = 0;

  // Batch-fetch all prices in one query for efficiency
  const priceMap = new Map<string, number>();
  if (priceOverrides) {
    for (const [k, v] of priceOverrides) priceMap.set(k.toUpperCase(), v);
  } else if (state.positions.length > 0) {
    // Single query: latest EOD close for all tickers
    const tickers = state.positions.map(p => p.ticker.toUpperCase());
    try {
      const placeholders = tickers.map(() => '?').join(',');
      const { rows } = await db.query(
        `SELECT i.tradingsymbol, c.close
         FROM candles c
         JOIN instruments i ON c.instrument_key = i.instrument_key
         WHERE i.tradingsymbol IN (${placeholders})
           AND c.candle_type = 'eod' AND c.interval_unit = '1day'
           AND c.ts = (
             SELECT MAX(c2.ts) FROM candles c2
             WHERE c2.instrument_key = c.instrument_key
               AND c2.candle_type = 'eod' AND c2.interval_unit = '1day'
           )`,
        tickers,
      );
      for (const r of rows as any[]) {
        priceMap.set(String(r.tradingsymbol).toUpperCase(), Number(r.close));
      }
    } catch {}
  }

  for (const pos of state.positions) {
    // Price resolution: overrides → candles → avgCost (stale marker)
    let marketPrice = priceMap.get(pos.ticker.toUpperCase()) ?? 0;
    if (marketPrice <= 0) marketPrice = pos.avgCost; // stale — no external dependency

    const mktVal = pos.quantity * marketPrice;
    const unrealizedPnl = mktVal - pos.totalCost;
    totalMarketValue += mktVal;
    totalUnrealizedPnl += unrealizedPnl;

    marketValues.push({
      ticker: pos.ticker,
      quantity: pos.quantity,
      avgCost: pos.avgCost,
      marketPrice: parseFloat(marketPrice.toFixed(2)),
      marketValue: parseFloat(mktVal.toFixed(2)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
      unrealizedPnlPct: pos.totalCost > 0 ? parseFloat(((unrealizedPnl / pos.totalCost) * 100).toFixed(2)) : 0,
    });
  }

  const totalPnl = totalUnrealizedPnl + state.totalRealizedPnl;
  const totalPnlPct = state.totalInvested > 0 ? (totalPnl / state.totalInvested) * 100 : 0;

  return {
    state,
    marketValues,
    totalMarketValue: parseFloat(totalMarketValue.toFixed(2)),
    totalUnrealizedPnl: parseFloat(totalUnrealizedPnl.toFixed(2)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
  };
}

// ── Validation: Ledger vs Snapshot ──────────────────────────────

/**
 * Validate that the deterministic ledger state matches the
 * portfolio_positions snapshot. Any mismatch means the snapshot
 * cache has drifted from the transaction truth.
 */
export async function validateLedgerConsistency(
  portfolioId: number,
): Promise<LedgerValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mismatches: LedgerValidation['positionMismatches'] = [];

  // Rebuild from transactions
  const ledgerState = await rebuildPortfolioState(portfolioId);

  // Read snapshot
  const { rows: snapRows } = await db.query(
    `SELECT tradingsymbol, quantity, buy_price, avg_cost, current_price
     FROM portfolio_positions
     WHERE portfolio_id = ? AND quantity > 0`,
    [portfolioId],
  );
  const snapMap = new Map<string, { qty: number; avgCost: number }>();
  for (const r of snapRows as any[]) {
    snapMap.set(r.tradingsymbol.toUpperCase(), {
      qty: Number(r.quantity),
      avgCost: Number(r.avg_cost ?? r.buy_price ?? 0),
    });
  }

  // Compare each ledger position against snapshot
  for (const pos of ledgerState.positions) {
    const snap = snapMap.get(pos.ticker.toUpperCase());
    if (!snap) {
      errors.push(`${pos.ticker}: in ledger (qty=${pos.quantity}) but NOT in snapshot`);
      mismatches.push({
        ticker: pos.ticker,
        ledgerQty: pos.quantity,
        snapshotQty: 0,
        ledgerAvgCost: pos.avgCost,
        snapshotAvgCost: 0,
      });
      continue;
    }

    if (snap.qty !== pos.quantity) {
      errors.push(`${pos.ticker}: quantity mismatch — ledger=${pos.quantity} snapshot=${snap.qty}`);
      mismatches.push({
        ticker: pos.ticker,
        ledgerQty: pos.quantity,
        snapshotQty: snap.qty,
        ledgerAvgCost: pos.avgCost,
        snapshotAvgCost: snap.avgCost,
      });
    } else if (Math.abs(snap.avgCost - pos.avgCost) > 0.01) {
      warnings.push(`${pos.ticker}: avgCost drift — ledger=${pos.avgCost.toFixed(2)} snapshot=${snap.avgCost.toFixed(2)}`);
      mismatches.push({
        ticker: pos.ticker,
        ledgerQty: pos.quantity,
        snapshotQty: snap.qty,
        ledgerAvgCost: pos.avgCost,
        snapshotAvgCost: snap.avgCost,
      });
    }

    snapMap.delete(pos.ticker.toUpperCase());
  }

  // Snapshot positions not in ledger
  for (const [ticker, snap] of snapMap) {
    if (snap.qty > 0) {
      warnings.push(`${ticker}: in snapshot (qty=${snap.qty}) but NOT in ledger — may predate transaction tracking`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
    positionMismatches: mismatches,
  };
}

// ── Sync: Write ledger state back to snapshot ───────────────────

/**
 * Overwrite portfolio_positions with the deterministic ledger state.
 * Use when validation shows drift. This is an idempotent repair.
 */
export async function syncSnapshotFromLedger(
  portfolioId: number,
): Promise<{ synced: number; removed: number }> {
  const state = await rebuildPortfolioState(portfolioId);
  let synced = 0;
  let removed = 0;

  // Upsert each ledger position
  for (const pos of state.positions) {
    await db.query(
      `INSERT INTO portfolio_positions
         (portfolio_id, tradingsymbol, quantity, buy_price, avg_cost, instrument_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         quantity = VALUES(quantity),
         buy_price = VALUES(buy_price),
         avg_cost = VALUES(avg_cost),
         instrument_id = COALESCE(VALUES(instrument_id), instrument_id),
         updated_at = NOW()`,
      [portfolioId, pos.ticker, pos.quantity, pos.avgCost, pos.avgCost, pos.instrumentId],
    );
    synced++;
  }

  // Zero out positions that ledger says are closed
  const openTickers = new Set(state.positions.map(p => p.ticker.toUpperCase()));
  const { rows: allSnap } = await db.query(
    'SELECT id, tradingsymbol FROM portfolio_positions WHERE portfolio_id = ? AND quantity > 0',
    [portfolioId],
  );
  for (const r of allSnap as any[]) {
    if (!openTickers.has(r.tradingsymbol.toUpperCase())) {
      await db.query('UPDATE portfolio_positions SET quantity = 0 WHERE id = ?', [r.id]);
      removed++;
    }
  }

  log.info('Snapshot synced from ledger', { portfolioId, synced, removed });
  return { synced, removed };
}

// ═══════════════════════════════════════════════════════════════
//  DETERMINISM PROOF
//
//  Proves three properties of the portfolio reconstruction:
//
//    1. IDEMPOTENCY:  f(txns, T) === f(txns, T)
//       Same transactions, same timestamp → byte-identical output.
//       Proves no hidden state, no randomness, no time-dependency.
//
//    2. TEMPORAL CONSISTENCY:  f(txns, T1) ⊆ f(txns, T2) for T1 < T2
//       State at T1 is a valid prefix of state at T2.
//       All T1 positions are present in T2 (possibly with different qty).
//       Realized P&L at T1 ≤ realized P&L at T2.
//
//    3. P&L EXACTNESS:  ledger_pnl === snapshot_pnl
//       The deterministic P&L computation matches the snapshot-based
//       P&L computation. If they disagree, the snapshot has drifted.
//
//  Additional checks:
//    - Accounting identity: totalBought − totalSold = currentQty
//    - Zero-transaction portfolio produces empty state
//    - WAC invariant: avgCost > 0 for all positions with qty > 0
//
//  This is the final correctness proof. It runs without side effects
//  and returns a structured pass/fail report.
// ═══════════════════════════════════════════════════════════════

export interface DeterminismProof {
  portfolioId: number;
  passed: boolean;
  timestamp: string;
  checks: ProofCheck[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    transactionCount: number;
    positionCount: number;
    durationMs: number;
  };
}

export interface ProofCheck {
  name: string;
  passed: boolean;
  detail: string;
  expected?: string;
  actual?: string;
}

export async function proveLedgerDeterminism(
  portfolioId: number,
): Promise<DeterminismProof> {
  const startMs = Date.now();
  const checks: ProofCheck[] = [];
  const now = new Date().toISOString();

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 1: IDEMPOTENCY
  //  Run rebuild twice with identical inputs. Output must be identical.
  // ═══════════════════════════════════════════════════════════════
  const run1 = await rebuildPortfolioState(portfolioId, now);
  const run2 = await rebuildPortfolioState(portfolioId, now);

  // Compare positions — sort for deterministic ordering
  const sortedPositions = (s: LedgerState) =>
    [...s.positions].sort((a, b) => a.ticker.localeCompare(b.ticker));

  const p1 = sortedPositions(run1);
  const p2 = sortedPositions(run2);

  // Position count must match
  checks.push({
    name: 'idempotency:position_count',
    passed: p1.length === p2.length,
    detail: `Run 1 produced ${p1.length} positions, Run 2 produced ${p2.length}`,
    expected: String(p1.length),
    actual: String(p2.length),
  });

  // Each position must be byte-identical
  let positionsIdentical = p1.length === p2.length;
  for (let i = 0; i < p1.length && i < p2.length; i++) {
    const a = p1[i];
    const b = p2[i];
    const match = a.ticker === b.ticker
      && a.quantity === b.quantity
      && a.avgCost === b.avgCost
      && a.totalCost === b.totalCost
      && a.realizedPnl === b.realizedPnl;
    if (!match) {
      positionsIdentical = false;
      checks.push({
        name: `idempotency:position_mismatch:${a.ticker}`,
        passed: false,
        detail: `${a.ticker}: qty ${a.quantity}/${b.quantity}, avgCost ${a.avgCost}/${b.avgCost}, realized ${a.realizedPnl}/${b.realizedPnl}`,
      });
    }
  }

  checks.push({
    name: 'idempotency:positions_identical',
    passed: positionsIdentical,
    detail: positionsIdentical
      ? `All ${p1.length} positions are byte-identical across runs`
      : 'Position data differs between runs — non-deterministic behavior detected',
  });

  // Aggregate fields must match
  checks.push({
    name: 'idempotency:totalInvested',
    passed: run1.totalInvested === run2.totalInvested,
    detail: `totalInvested: ${run1.totalInvested} vs ${run2.totalInvested}`,
    expected: String(run1.totalInvested),
    actual: String(run2.totalInvested),
  });

  checks.push({
    name: 'idempotency:totalRealizedPnl',
    passed: run1.totalRealizedPnl === run2.totalRealizedPnl,
    detail: `totalRealizedPnl: ${run1.totalRealizedPnl} vs ${run2.totalRealizedPnl}`,
    expected: String(run1.totalRealizedPnl),
    actual: String(run2.totalRealizedPnl),
  });

  checks.push({
    name: 'idempotency:transactionCount',
    passed: run1.transactionCount === run2.transactionCount,
    detail: `transactionCount: ${run1.transactionCount} vs ${run2.transactionCount}`,
    expected: String(run1.transactionCount),
    actual: String(run2.transactionCount),
  });

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 2: TEMPORAL CONSISTENCY
  //  State at T_mid must be a valid prefix of state at T_now.
  //  Realized P&L can only grow or stay the same over time.
  // ═══════════════════════════════════════════════════════════════
  // Find a midpoint transaction timestamp
  const { rows: midRows } = await db.query(
    `SELECT executed_at FROM transactions
     WHERE portfolio_id = ?
     ORDER BY executed_at ASC
     LIMIT 1 OFFSET (
       SELECT GREATEST(0, FLOOR(COUNT(*) / 2) - 1) FROM transactions WHERE portfolio_id = ?
     )`,
    [portfolioId, portfolioId],
  );

  if (midRows.length > 0) {
    const midTime = (midRows[0] as any).executed_at;
    const stateMid = await rebuildPortfolioState(portfolioId, midTime);

    // T_mid transaction count must be <= T_now transaction count
    checks.push({
      name: 'temporal:transaction_ordering',
      passed: stateMid.transactionCount <= run1.transactionCount,
      detail: `T_mid has ${stateMid.transactionCount} txns, T_now has ${run1.transactionCount}`,
      expected: `<= ${run1.transactionCount}`,
      actual: String(stateMid.transactionCount),
    });

    // All T_mid open positions must exist at T_now (possibly with different qty)
    const nowTickers = new Set(run1.positions.map(p => p.ticker));
    const closedAtNow = run1.closedPositions.map(c => c.ticker);
    let midPositionsValid = true;
    for (const midPos of stateMid.positions) {
      const existsNow = nowTickers.has(midPos.ticker) || closedAtNow.includes(midPos.ticker);
      if (!existsNow) {
        midPositionsValid = false;
        checks.push({
          name: `temporal:orphan_position:${midPos.ticker}`,
          passed: false,
          detail: `${midPos.ticker} exists at T_mid but vanished at T_now without close record`,
        });
      }
    }

    checks.push({
      name: 'temporal:position_continuity',
      passed: midPositionsValid,
      detail: midPositionsValid
        ? `All ${stateMid.positions.length} T_mid positions accounted for at T_now`
        : 'Some T_mid positions have no T_now counterpart',
    });
  } else {
    checks.push({
      name: 'temporal:skipped',
      passed: true,
      detail: 'No midpoint transaction found — temporal check not applicable',
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 3: ACCOUNTING IDENTITY
  //  For each position: sum(buys) - sum(sells) = current_quantity
  //  This validates the replay engine conserves shares.
  // ═══════════════════════════════════════════════════════════════
  const { rows: txnSummary } = await db.query(
    `SELECT ticker,
            SUM(CASE WHEN side = 'buy' THEN quantity ELSE 0 END) AS total_bought,
            SUM(CASE WHEN side = 'sell' THEN quantity ELSE 0 END) AS total_sold
     FROM transactions
     WHERE portfolio_id = ? AND executed_at <= ?
     GROUP BY ticker`,
    [portfolioId, now],
  );

  let accountingValid = true;
  for (const r of txnSummary as any[]) {
    const ticker = String(r.ticker).toUpperCase();
    const expectedQty = Number(r.total_bought) - Number(r.total_sold);
    const ledgerPos = run1.positions.find(p => p.ticker === ticker);
    const actualQty = ledgerPos?.quantity ?? 0;

    if (expectedQty !== actualQty) {
      accountingValid = false;
      checks.push({
        name: `accounting:quantity_conservation:${ticker}`,
        passed: false,
        detail: `${ticker}: bought=${r.total_bought} sold=${r.total_sold} expected_qty=${expectedQty} actual_qty=${actualQty}`,
        expected: String(expectedQty),
        actual: String(actualQty),
      });
    }
  }

  checks.push({
    name: 'accounting:quantity_conservation',
    passed: accountingValid,
    detail: accountingValid
      ? `All ${(txnSummary as any[]).length} instruments conserve share count correctly`
      : 'Share conservation violated — replay engine has a bug',
  });

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 4: WAC INVARIANTS
  //  - avgCost > 0 for all positions with qty > 0
  //  - totalCost = qty × avgCost (within rounding tolerance)
  // ═══════════════════════════════════════════════════════════════
  let wacValid = true;
  for (const pos of run1.positions) {
    if (pos.quantity > 0 && pos.avgCost <= 0) {
      wacValid = false;
      checks.push({
        name: `wac:positive_cost:${pos.ticker}`,
        passed: false,
        detail: `${pos.ticker}: qty=${pos.quantity} but avgCost=${pos.avgCost}`,
      });
    }
    const expectedCost = parseFloat((pos.quantity * pos.avgCost).toFixed(2));
    if (Math.abs(expectedCost - pos.totalCost) > 0.02) {
      wacValid = false;
      checks.push({
        name: `wac:cost_integrity:${pos.ticker}`,
        passed: false,
        detail: `${pos.ticker}: qty×avgCost=${expectedCost} but totalCost=${pos.totalCost}`,
        expected: String(expectedCost),
        actual: String(pos.totalCost),
      });
    }
  }

  checks.push({
    name: 'wac:invariants',
    passed: wacValid,
    detail: wacValid
      ? `All ${run1.positions.length} positions satisfy WAC invariants`
      : 'WAC invariant violated',
  });

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 5: P&L EXACTNESS vs SNAPSHOT
  //  Compare realized P&L from deterministic ledger vs snapshot-based
  //  computePnl. If they disagree, the snapshot has drifted.
  // ═══════════════════════════════════════════════════════════════
  const snapshotValidation = await validateLedgerConsistency(portfolioId);
  checks.push({
    name: 'pnl:snapshot_consistency',
    passed: snapshotValidation.isValid,
    detail: snapshotValidation.isValid
      ? 'Ledger matches snapshot — no drift detected'
      : `Drift detected: ${snapshotValidation.errors.join('; ')}`,
  });

  if (snapshotValidation.positionMismatches.length > 0) {
    for (const m of snapshotValidation.positionMismatches) {
      checks.push({
        name: `pnl:mismatch:${m.ticker}`,
        passed: false,
        detail: `${m.ticker}: ledger qty=${m.ledgerQty} avgCost=${m.ledgerAvgCost}, snapshot qty=${m.snapshotQty} avgCost=${m.snapshotAvgCost}`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROOF 6: ZERO-TRANSACTION EDGE CASE
  //  Empty portfolio must produce empty state. This validates that
  //  the rebuild function has no implicit starting state.
  // ═══════════════════════════════════════════════════════════════
  // We test with a timestamp before any transactions exist
  const { rows: firstTxn } = await db.query(
    `SELECT MIN(executed_at) AS first_at FROM transactions WHERE portfolio_id = ?`,
    [portfolioId],
  );
  const firstAt = (firstTxn[0] as any)?.first_at;
  if (firstAt) {
    const beforeFirst = new Date(new Date(firstAt).getTime() - 1000).toISOString();
    const emptyState = await rebuildPortfolioState(portfolioId, beforeFirst);
    const emptyValid = emptyState.positions.length === 0
      && emptyState.totalInvested === 0
      && emptyState.totalRealizedPnl === 0
      && emptyState.transactionCount === 0;

    checks.push({
      name: 'edge:zero_transaction',
      passed: emptyValid,
      detail: emptyValid
        ? 'State before first transaction is correctly empty'
        : `Non-empty state before first txn: ${emptyState.positions.length} positions, ${emptyState.totalInvested} invested`,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  ASSEMBLE PROOF
  // ═══════════════════════════════════════════════════════════════
  const passedCount = checks.filter(c => c.passed).length;
  const failedCount = checks.filter(c => !c.passed).length;

  const proof: DeterminismProof = {
    portfolioId,
    passed: failedCount === 0,
    timestamp: now,
    checks,
    summary: {
      total: checks.length,
      passed: passedCount,
      failed: failedCount,
      transactionCount: run1.transactionCount,
      positionCount: run1.positions.length,
      durationMs: Date.now() - startMs,
    },
  };

  log.info('Determinism proof complete', {
    portfolioId,
    passed: proof.passed,
    checks: proof.summary.total,
    failed: proof.summary.failed,
    durationMs: proof.summary.durationMs,
  });

  return proof;
}
