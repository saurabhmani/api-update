// Paper Trading — MySQL persistence + runtime migration

import { db } from '@/lib/db';
import { DEFAULT_PAPER_RISK } from '../types';
import type {
  PaperAccount,
  PaperFill,
  PaperOrder,
  PaperPosition,
  PaperRiskConfig,
  RiskEvent,
  RiskProfile,
  TradeLog,
} from '../types';

let migrated = false;

export async function ensurePaperTradingTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS paper_accounts (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(128) NOT NULL DEFAULT 'Paper Account',
        virtual_capital DECIMAL(18,2) NOT NULL DEFAULT 1000000,
        cash_balance DECIMAL(18,2) NOT NULL,
        equity DECIMAL(18,2) NOT NULL,
        realized_pnl DECIMAL(18,2) NOT NULL DEFAULT 0,
        unrealized_pnl DECIMAL(18,2) NOT NULL DEFAULT 0,
        max_daily_loss_pct DECIMAL(6,2) NOT NULL DEFAULT 2,
        max_open_positions INT NOT NULL DEFAULT 5,
        max_trades_per_day INT NOT NULL DEFAULT 20,
        risk_per_trade_pct DECIMAL(6,2) NOT NULL DEFAULT 0.5,
        max_consecutive_losses INT NOT NULL DEFAULT 3,
        max_symbol_exposure_pct DECIMAL(6,2) NOT NULL DEFAULT 15,
        max_strategy_exposure_pct DECIMAL(6,2) NOT NULL DEFAULT 25,
        slippage_bps DECIMAL(8,2) NOT NULL DEFAULT 10,
        circuit_breaker_drop_pct DECIMAL(6,2) NOT NULL DEFAULT 5,
        high_volatility_atr_pct DECIMAL(6,2) NOT NULL DEFAULT 6,
        consecutive_losses INT NOT NULL DEFAULT 0,
        daily_pnl DECIMAL(18,2) NOT NULL DEFAULT 0,
        daily_pnl_reset_at DATE,
        kill_switch_active TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_paper_accounts_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS paper_orders (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        symbol VARCHAR(32) NOT NULL,
        side VARCHAR(8) NOT NULL,
        order_type VARCHAR(16) NOT NULL DEFAULT 'MARKET',
        role VARCHAR(16) NOT NULL DEFAULT 'ENTRY',
        quantity INT NOT NULL,
        limit_price DECIMAL(14,4),
        stop_price DECIMAL(14,4),
        trigger_price DECIMAL(14,4),
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        strategy_id VARCHAR(64),
        parent_order_id VARCHAR(64),
        position_id VARCHAR(64),
        filled_qty INT NOT NULL DEFAULT 0,
        avg_fill_price DECIMAL(14,4),
        reject_reason TEXT,
        idempotency_key VARCHAR(128),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_paper_idem (account_id, idempotency_key),
        INDEX idx_paper_orders_account_status (account_id, status),
        INDEX idx_paper_orders_symbol (symbol, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS paper_positions (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        symbol VARCHAR(32) NOT NULL,
        side VARCHAR(8) NOT NULL,
        quantity INT NOT NULL,
        entry_price DECIMAL(14,4) NOT NULL,
        current_price DECIMAL(14,4),
        stop_loss DECIMAL(14,4),
        take_profit DECIMAL(14,4),
        unrealized_pnl DECIMAL(18,4) NOT NULL DEFAULT 0,
        realized_pnl DECIMAL(18,4),
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        strategy_id VARCHAR(64),
        entry_order_id VARCHAR(64),
        exit_order_id VARCHAR(64),
        exit_reason VARCHAR(32),
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_paper_positions_account (account_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS paper_fills (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        order_id VARCHAR(64) NOT NULL,
        position_id VARCHAR(64),
        symbol VARCHAR(32) NOT NULL,
        side VARCHAR(8) NOT NULL,
        quantity INT NOT NULL,
        fill_price DECIMAL(14,4) NOT NULL,
        slippage_bps DECIMAL(8,2) NOT NULL DEFAULT 0,
        fees DECIMAL(14,4) NOT NULL DEFAULT 0,
        filled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_paper_fills_account (account_id, filled_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS paper_kill_switch_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(64),
        user_id INT,
        action VARCHAR(32) NOT NULL,
        reason TEXT,
        actor VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_paper_kill_switch_account (account_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS trade_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        order_id VARCHAR(64),
        position_id VARCHAR(64),
        symbol VARCHAR(32) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        side VARCHAR(8),
        quantity INT,
        price DECIMAL(14,4),
        pnl DECIMAL(18,4),
        fees DECIMAL(14,4) DEFAULT 0,
        strategy_id VARCHAR(64),
        details_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_trade_logs_account (account_id, created_at),
        INDEX idx_trade_logs_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS risk_profiles (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        account_id VARCHAR(64),
        virtual_capital DECIMAL(18,2) NOT NULL DEFAULT 1000000,
        risk_per_trade_pct DECIMAL(6,2) NOT NULL DEFAULT 0.5,
        max_daily_loss_pct DECIMAL(6,2) NOT NULL DEFAULT 2,
        max_open_positions INT NOT NULL DEFAULT 5,
        max_trades_per_day INT NOT NULL DEFAULT 20,
        max_consecutive_losses INT NOT NULL DEFAULT 3,
        max_symbol_exposure_pct DECIMAL(6,2) NOT NULL DEFAULT 15,
        max_strategy_exposure_pct DECIMAL(6,2) NOT NULL DEFAULT 25,
        slippage_bps DECIMAL(8,2) NOT NULL DEFAULT 10,
        circuit_breaker_drop_pct DECIMAL(6,2) NOT NULL DEFAULT 5,
        high_volatility_atr_pct DECIMAL(6,2) NOT NULL DEFAULT 6,
        kill_switch_active TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_risk_profiles_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS risk_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        account_id VARCHAR(64),
        event_type VARCHAR(32) NOT NULL,
        code VARCHAR(64) NOT NULL,
        message TEXT NOT NULL,
        symbol VARCHAR(32),
        strategy_id VARCHAR(64),
        blocked TINYINT(1) NOT NULL DEFAULT 1,
        details_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_risk_events_user (user_id, created_at),
        INDEX idx_risk_events_account (account_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`ALTER TABLE paper_accounts ADD COLUMN max_trades_per_day INT NOT NULL DEFAULT 20`).catch(() => null);
    await db.query(`ALTER TABLE risk_profiles ADD COLUMN max_trades_per_day INT NOT NULL DEFAULT 20`).catch(() => null);
    migrated = true;
  } catch {
    migrated = true;
  }
}

function mapRisk(row: Record<string, unknown>): PaperRiskConfig {
  return {
    virtualCapital: Number(row.virtual_capital ?? DEFAULT_PAPER_RISK.virtualCapital),
    riskPerTradePct: Number(row.risk_per_trade_pct ?? DEFAULT_PAPER_RISK.riskPerTradePct),
    maxDailyLossPct: Number(row.max_daily_loss_pct ?? DEFAULT_PAPER_RISK.maxDailyLossPct),
    maxOpenPositions: Number(row.max_open_positions ?? DEFAULT_PAPER_RISK.maxOpenPositions),
    maxTradesPerDay: Number(row.max_trades_per_day ?? DEFAULT_PAPER_RISK.maxTradesPerDay),
    maxConsecutiveLosses: Number(row.max_consecutive_losses ?? DEFAULT_PAPER_RISK.maxConsecutiveLosses),
    maxSymbolExposurePct: Number(row.max_symbol_exposure_pct ?? DEFAULT_PAPER_RISK.maxSymbolExposurePct),
    maxStrategyExposurePct: Number(row.max_strategy_exposure_pct ?? DEFAULT_PAPER_RISK.maxStrategyExposurePct),
    slippageBps: Number(row.slippage_bps ?? DEFAULT_PAPER_RISK.slippageBps),
    circuitBreakerDropPct: Number(row.circuit_breaker_drop_pct ?? DEFAULT_PAPER_RISK.circuitBreakerDropPct),
    highVolatilityAtrPct: Number(row.high_volatility_atr_pct ?? DEFAULT_PAPER_RISK.highVolatilityAtrPct),
  };
}

function mapAccount(row: Record<string, unknown>): PaperAccount {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    name: String(row.name),
    virtualCapital: Number(row.virtual_capital),
    cashBalance: Number(row.cash_balance),
    equity: Number(row.equity),
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    risk: mapRisk(row),
    consecutiveLosses: Number(row.consecutive_losses),
    dailyPnl: Number(row.daily_pnl),
    killSwitchActive: Boolean(row.kill_switch_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapOrder(row: Record<string, unknown>): PaperOrder {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    symbol: String(row.symbol),
    side: row.side as PaperOrder['side'],
    orderType: row.order_type as PaperOrder['orderType'],
    role: row.role as PaperOrder['role'],
    quantity: Number(row.quantity),
    limitPrice: row.limit_price != null ? Number(row.limit_price) : null,
    stopPrice: row.stop_price != null ? Number(row.stop_price) : null,
    triggerPrice: row.trigger_price != null ? Number(row.trigger_price) : null,
    status: row.status as PaperOrder['status'],
    strategyId: row.strategy_id ? String(row.strategy_id) : null,
    parentOrderId: row.parent_order_id ? String(row.parent_order_id) : null,
    positionId: row.position_id ? String(row.position_id) : null,
    filledQty: Number(row.filled_qty),
    avgFillPrice: row.avg_fill_price != null ? Number(row.avg_fill_price) : null,
    rejectReason: row.reject_reason ? String(row.reject_reason) : null,
    idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPosition(row: Record<string, unknown>): PaperPosition {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    symbol: String(row.symbol),
    side: row.side as PaperPosition['side'],
    quantity: Number(row.quantity),
    entryPrice: Number(row.entry_price),
    currentPrice: row.current_price != null ? Number(row.current_price) : null,
    stopLoss: row.stop_loss != null ? Number(row.stop_loss) : null,
    takeProfit: row.take_profit != null ? Number(row.take_profit) : null,
    unrealizedPnl: Number(row.unrealized_pnl),
    realizedPnl: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    status: row.status as PaperPosition['status'],
    strategyId: row.strategy_id ? String(row.strategy_id) : null,
    entryOrderId: row.entry_order_id ? String(row.entry_order_id) : null,
    exitOrderId: row.exit_order_id ? String(row.exit_order_id) : null,
    exitReason: row.exit_reason ? String(row.exit_reason) : null,
    openedAt: String(row.opened_at),
    closedAt: row.closed_at ? String(row.closed_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapFill(row: Record<string, unknown>): PaperFill {
  return {
    id: Number(row.id),
    accountId: String(row.account_id),
    orderId: String(row.order_id),
    positionId: row.position_id ? String(row.position_id) : null,
    symbol: String(row.symbol),
    side: row.side as PaperFill['side'],
    quantity: Number(row.quantity),
    fillPrice: Number(row.fill_price),
    slippageBps: Number(row.slippage_bps),
    fees: Number(row.fees),
    filledAt: String(row.filled_at),
  };
}

export async function findAccountByUser(userId: number): Promise<PaperAccount | null> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(`SELECT * FROM paper_accounts WHERE user_id = ? LIMIT 1`, [userId]);
  return rows.length ? mapAccount(rows[0] as Record<string, unknown>) : null;
}

export async function insertAccount(
  id: string,
  userId: number,
  capital: number,
  name = 'Paper Account',
): Promise<PaperAccount> {
  await ensurePaperTradingTables();
  const r = DEFAULT_PAPER_RISK;
  await db.query(
    `INSERT INTO paper_accounts
       (id, user_id, name, virtual_capital, cash_balance, equity,
        max_daily_loss_pct, max_open_positions, max_trades_per_day, risk_per_trade_pct, max_consecutive_losses,
        max_symbol_exposure_pct, max_strategy_exposure_pct, slippage_bps,
        circuit_breaker_drop_pct, high_volatility_atr_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, name, capital, capital, capital,
      r.maxDailyLossPct, r.maxOpenPositions, r.maxTradesPerDay, r.riskPerTradePct, r.maxConsecutiveLosses,
      r.maxSymbolExposurePct, r.maxStrategyExposurePct, r.slippageBps,
      r.circuitBreakerDropPct, r.highVolatilityAtrPct,
    ],
  );
  const acct = await findAccountByUser(userId);
  if (!acct) throw new Error('Failed to create paper account');
  return acct;
}

export async function updateAccountBalances(
  accountId: string,
  patch: Partial<{
    cashBalance: number;
    equity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    dailyPnl: number;
    consecutiveLosses: number;
    killSwitchActive: boolean;
    dailyPnlResetAt: string;
  }>,
): Promise<void> {
  await ensurePaperTradingTables();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.cashBalance != null) { sets.push('cash_balance = ?'); vals.push(patch.cashBalance); }
  if (patch.equity != null) { sets.push('equity = ?'); vals.push(patch.equity); }
  if (patch.realizedPnl != null) { sets.push('realized_pnl = ?'); vals.push(patch.realizedPnl); }
  if (patch.unrealizedPnl != null) { sets.push('unrealized_pnl = ?'); vals.push(patch.unrealizedPnl); }
  if (patch.dailyPnl != null) { sets.push('daily_pnl = ?'); vals.push(patch.dailyPnl); }
  if (patch.consecutiveLosses != null) { sets.push('consecutive_losses = ?'); vals.push(patch.consecutiveLosses); }
  if (patch.killSwitchActive != null) { sets.push('kill_switch_active = ?'); vals.push(patch.killSwitchActive ? 1 : 0); }
  if (patch.dailyPnlResetAt != null) { sets.push('daily_pnl_reset_at = ?'); vals.push(patch.dailyPnlResetAt); }
  if (!sets.length) return;
  vals.push(accountId);
  await db.query(`UPDATE paper_accounts SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export async function insertOrder(order: PaperOrder): Promise<void> {
  await ensurePaperTradingTables();
  await db.query(
    `INSERT INTO paper_orders
       (id, account_id, symbol, side, order_type, role, quantity, limit_price, stop_price,
        trigger_price, status, strategy_id, parent_order_id, position_id, filled_qty,
        avg_fill_price, reject_reason, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      order.id, order.accountId, order.symbol, order.side, order.orderType, order.role,
      order.quantity, order.limitPrice ?? null, order.stopPrice ?? null, order.triggerPrice ?? null,
      order.status, order.strategyId ?? null, order.parentOrderId ?? null, order.positionId ?? null,
      order.filledQty, order.avgFillPrice ?? null, order.rejectReason ?? null, order.idempotencyKey ?? null,
    ],
  );
}

export async function updateOrder(order: PaperOrder): Promise<void> {
  await ensurePaperTradingTables();
  await db.query(
    `UPDATE paper_orders SET status=?, filled_qty=?, avg_fill_price=?, reject_reason=?,
       position_id=?, updated_at=NOW() WHERE id=?`,
    [order.status, order.filledQty, order.avgFillPrice ?? null, order.rejectReason ?? null,
     order.positionId ?? null, order.id],
  );
}

export async function listOrders(
  accountId: string,
  status?: string[],
): Promise<PaperOrder[]> {
  await ensurePaperTradingTables();
  if (status?.length) {
    const placeholders = status.map(() => '?').join(',');
    const { rows } = await db.query(
      `SELECT * FROM paper_orders WHERE account_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`,
      [accountId, ...status],
    );
    return rows.map((r) => mapOrder(r as Record<string, unknown>));
  }
  const { rows } = await db.query(
    `SELECT * FROM paper_orders WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`,
    [accountId],
  );
  return rows.map((r) => mapOrder(r as Record<string, unknown>));
}

export async function findOrderByIdempotency(
  accountId: string,
  key: string,
): Promise<PaperOrder | null> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM paper_orders WHERE account_id = ? AND idempotency_key = ? LIMIT 1`,
    [accountId, key],
  );
  return rows.length ? mapOrder(rows[0] as Record<string, unknown>) : null;
}

export async function insertPosition(pos: PaperPosition): Promise<void> {
  await ensurePaperTradingTables();
  await db.query(
    `INSERT INTO paper_positions
       (id, account_id, symbol, side, quantity, entry_price, current_price, stop_loss,
        take_profit, unrealized_pnl, status, strategy_id, entry_order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pos.id, pos.accountId, pos.symbol, pos.side, pos.quantity, pos.entryPrice,
      pos.currentPrice ?? pos.entryPrice, pos.stopLoss ?? null, pos.takeProfit ?? null,
      pos.unrealizedPnl, pos.status, pos.strategyId ?? null, pos.entryOrderId ?? null,
    ],
  );
}

export async function updatePosition(pos: PaperPosition): Promise<void> {
  await ensurePaperTradingTables();
  await db.query(
    `UPDATE paper_positions SET current_price=?, unrealized_pnl=?, realized_pnl=?, status=?,
       exit_order_id=?, exit_reason=?, closed_at=?, updated_at=NOW() WHERE id=?`,
    [
      pos.currentPrice ?? null, pos.unrealizedPnl, pos.realizedPnl ?? null, pos.status,
      pos.exitOrderId ?? null, pos.exitReason ?? null, pos.closedAt ?? null, pos.id,
    ],
  );
}

export async function listOpenPositions(accountId: string): Promise<PaperPosition[]> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM paper_positions WHERE account_id = ? AND status = 'OPEN' ORDER BY opened_at DESC`,
    [accountId],
  );
  return rows.map((r) => mapPosition(r as Record<string, unknown>));
}

export async function getPositionById(id: string): Promise<PaperPosition | null> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(`SELECT * FROM paper_positions WHERE id = ? LIMIT 1`, [id]);
  return rows.length ? mapPosition(rows[0] as Record<string, unknown>) : null;
}

export async function insertFill(fill: Omit<PaperFill, 'id' | 'filledAt'>): Promise<number> {
  await ensurePaperTradingTables();
  const result = await db.query(
    `INSERT INTO paper_fills
       (account_id, order_id, position_id, symbol, side, quantity, fill_price, slippage_bps, fees)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fill.accountId, fill.orderId, fill.positionId ?? null, fill.symbol, fill.side,
      fill.quantity, fill.fillPrice, fill.slippageBps, fill.fees,
    ],
  );
  return Number(result.insertId ?? 0);
}

export async function listRecentFills(accountId: string, limit = 50): Promise<PaperFill[]> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM paper_fills WHERE account_id = ? ORDER BY filled_at DESC LIMIT ?`,
    [accountId, limit],
  );
  return rows.map((r) => mapFill(r as Record<string, unknown>));
}

export async function logKillSwitch(
  accountId: string | null,
  userId: number,
  action: string,
  reason: string,
  actor: string,
): Promise<void> {
  await ensurePaperTradingTables();
  await db.query(
    `INSERT INTO paper_kill_switch_log (account_id, user_id, action, reason, actor) VALUES (?, ?, ?, ?, ?)`,
    [accountId, userId, action, reason, actor],
  );
}

export async function journalPaperTrade(
  userId: number,
  pos: PaperPosition,
  fees: number,
): Promise<void> {
  const exitPrice = pos.currentPrice ?? pos.entryPrice;
  const pnl = (pos.realizedPnl ?? 0) - fees;
  const notional = pos.entryPrice * pos.quantity;
  const pnlPct = notional > 0 ? (pnl / notional) * 100 : 0;
  const outcome = pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';
  try {
    await db.query(
      `INSERT INTO trade_journal
         (user_id, tradingsymbol, exchange, direction, entry_price, exit_price, quantity,
          entry_date, exit_date, strategy, notes, outcome, pnl, pnl_pct, tags)
       VALUES (?, ?, 'NSE', ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
      [
        userId, pos.symbol, pos.side, pos.entryPrice, exitPrice, pos.quantity,
        pos.openedAt, pos.strategyId ?? null,
        `Paper trade auto-journaled (${pos.exitReason ?? 'CLOSE'})`,
        outcome, pnl, pnlPct, JSON.stringify(['paper-trading']),
      ],
    );
  } catch { /* best effort */ }
}

export async function listClosedPositions(accountId: string, limit = 50): Promise<PaperPosition[]> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM paper_positions WHERE account_id = ? AND status = 'CLOSED' ORDER BY closed_at DESC LIMIT ?`,
    [accountId, limit],
  );
  return rows.map((r) => mapPosition(r as Record<string, unknown>));
}

export async function insertTradeLog(entry: {
  accountId: string;
  userId: number;
  orderId?: string;
  positionId?: string;
  symbol: string;
  eventType: string;
  side?: string;
  quantity?: number;
  price?: number;
  pnl?: number;
  fees?: number;
  strategyId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await ensurePaperTradingTables();
  try {
    await db.query(
      `INSERT INTO trade_logs
         (account_id, user_id, order_id, position_id, symbol, event_type, side,
          quantity, price, pnl, fees, strategy_id, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.accountId, entry.userId, entry.orderId ?? null, entry.positionId ?? null,
        entry.symbol, entry.eventType, entry.side ?? null, entry.quantity ?? null,
        entry.price ?? null, entry.pnl ?? null, entry.fees ?? null,
        entry.strategyId ?? null, entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  } catch { /* best effort */ }
}

export async function listTradeLogs(userId: number, limit = 50): Promise<TradeLog[]> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM trade_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number((r as Record<string, unknown>).id),
    accountId: String((r as Record<string, unknown>).account_id),
    userId: Number((r as Record<string, unknown>).user_id),
    orderId: (r as Record<string, unknown>).order_id ? String((r as Record<string, unknown>).order_id) : null,
    positionId: (r as Record<string, unknown>).position_id ? String((r as Record<string, unknown>).position_id) : null,
    symbol: String((r as Record<string, unknown>).symbol),
    eventType: String((r as Record<string, unknown>).event_type),
    side: (r as Record<string, unknown>).side ? String((r as Record<string, unknown>).side) : null,
    quantity: (r as Record<string, unknown>).quantity != null ? Number((r as Record<string, unknown>).quantity) : null,
    price: (r as Record<string, unknown>).price != null ? Number((r as Record<string, unknown>).price) : null,
    pnl: (r as Record<string, unknown>).pnl != null ? Number((r as Record<string, unknown>).pnl) : null,
    fees: (r as Record<string, unknown>).fees != null ? Number((r as Record<string, unknown>).fees) : null,
    strategyId: (r as Record<string, unknown>).strategy_id ? String((r as Record<string, unknown>).strategy_id) : null,
    createdAt: String((r as Record<string, unknown>).created_at),
  }));
}

function mapRiskProfile(row: Record<string, unknown>): RiskProfile {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    accountId: row.account_id ? String(row.account_id) : null,
    risk: mapRisk(row),
    killSwitchActive: Boolean(row.kill_switch_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export async function getRiskProfile(userId: number): Promise<RiskProfile | null> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(`SELECT * FROM risk_profiles WHERE user_id = ? LIMIT 1`, [userId]);
  return rows.length ? mapRiskProfile(rows[0] as Record<string, unknown>) : null;
}

export async function upsertRiskProfile(
  userId: number,
  accountId: string | null,
  risk: Partial<PaperRiskConfig> & { killSwitchActive?: boolean },
): Promise<RiskProfile> {
  await ensurePaperTradingTables();
  const existing = await getRiskProfile(userId);
  const id = existing?.id ?? `rp_${userId}`;
  const r = { ...DEFAULT_PAPER_RISK, ...existing?.risk, ...risk };
  const killActive = risk.killSwitchActive != null
    ? (risk.killSwitchActive ? 1 : 0)
    : (existing?.killSwitchActive ? 1 : 0);
  await db.query(
    `INSERT INTO risk_profiles
       (id, user_id, account_id, virtual_capital, risk_per_trade_pct, max_daily_loss_pct,
        max_open_positions, max_trades_per_day, max_consecutive_losses, max_symbol_exposure_pct,
        max_strategy_exposure_pct, slippage_bps, circuit_breaker_drop_pct,
        high_volatility_atr_pct, kill_switch_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       account_id=VALUES(account_id), virtual_capital=VALUES(virtual_capital),
       risk_per_trade_pct=VALUES(risk_per_trade_pct), max_daily_loss_pct=VALUES(max_daily_loss_pct),
       max_open_positions=VALUES(max_open_positions), max_trades_per_day=VALUES(max_trades_per_day),
       max_consecutive_losses=VALUES(max_consecutive_losses),
       max_symbol_exposure_pct=VALUES(max_symbol_exposure_pct),
       max_strategy_exposure_pct=VALUES(max_strategy_exposure_pct), slippage_bps=VALUES(slippage_bps),
       circuit_breaker_drop_pct=VALUES(circuit_breaker_drop_pct),
       high_volatility_atr_pct=VALUES(high_volatility_atr_pct),
       kill_switch_active=VALUES(kill_switch_active), updated_at=NOW()`,
    [
      id, userId, accountId, r.virtualCapital, r.riskPerTradePct, r.maxDailyLossPct,
      r.maxOpenPositions, r.maxTradesPerDay, r.maxConsecutiveLosses, r.maxSymbolExposurePct,
      r.maxStrategyExposurePct, r.slippageBps, r.circuitBreakerDropPct,
      r.highVolatilityAtrPct, killActive,
    ],
  );
  if (accountId) {
    const acctSets = [
      'virtual_capital=?', 'risk_per_trade_pct=?', 'max_daily_loss_pct=?',
      'max_open_positions=?', 'max_trades_per_day=?', 'max_consecutive_losses=?', 'max_symbol_exposure_pct=?',
      'max_strategy_exposure_pct=?', 'slippage_bps=?', 'circuit_breaker_drop_pct=?',
      'high_volatility_atr_pct=?',
    ];
    const acctVals: unknown[] = [
      r.virtualCapital, r.riskPerTradePct, r.maxDailyLossPct, r.maxOpenPositions,
      r.maxTradesPerDay, r.maxConsecutiveLosses, r.maxSymbolExposurePct, r.maxStrategyExposurePct,
      r.slippageBps, r.circuitBreakerDropPct, r.highVolatilityAtrPct,
    ];
    if (risk.killSwitchActive != null) {
      acctSets.push('kill_switch_active=?');
      acctVals.push(killActive);
    }
    acctVals.push(accountId);
    await db.query(
      `UPDATE paper_accounts SET ${acctSets.join(', ')} WHERE id=?`,
      acctVals,
    );
  }
  return (await getRiskProfile(userId))!;
}

export async function insertRiskEvent(entry: {
  userId: number;
  accountId?: string;
  eventType: string;
  code: string;
  message: string;
  symbol?: string;
  strategyId?: string;
  blocked?: boolean;
  details?: Record<string, unknown>;
}): Promise<void> {
  await ensurePaperTradingTables();
  try {
    await db.query(
      `INSERT INTO risk_events
         (user_id, account_id, event_type, code, message, symbol, strategy_id, blocked, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.userId, entry.accountId ?? null, entry.eventType, entry.code, entry.message,
        entry.symbol ?? null, entry.strategyId ?? null, entry.blocked !== false ? 1 : 0,
        entry.details ? JSON.stringify(entry.details) : null,
      ],
    );
  } catch { /* best effort */ }
}

export async function listRiskEvents(userId: number, limit = 30): Promise<RiskEvent[]> {
  await ensurePaperTradingTables();
  const { rows } = await db.query(
    `SELECT * FROM risk_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: Number((r as Record<string, unknown>).id),
    userId: Number((r as Record<string, unknown>).user_id),
    accountId: (r as Record<string, unknown>).account_id ? String((r as Record<string, unknown>).account_id) : null,
    eventType: String((r as Record<string, unknown>).event_type),
    code: String((r as Record<string, unknown>).code),
    message: String((r as Record<string, unknown>).message),
    symbol: (r as Record<string, unknown>).symbol ? String((r as Record<string, unknown>).symbol) : null,
    strategyId: (r as Record<string, unknown>).strategy_id ? String((r as Record<string, unknown>).strategy_id) : null,
    blocked: Boolean((r as Record<string, unknown>).blocked),
    createdAt: String((r as Record<string, unknown>).created_at),
  }));
}
