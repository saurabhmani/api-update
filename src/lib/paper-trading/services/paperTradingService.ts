// Paper Trading Service — orchestrates engine, risk, fills, journal

import { v4 as uuidv4 } from 'uuid';
import { getMarketStatus, isMarketOpen } from '@/lib/marketData/marketHours';
import { getLivePrice } from '@/lib/marketData/getLivePrice';
import { isGlobalKillSwitchActive } from '../killSwitch';
import { simulateFill } from '../orderSimulator';
import {
  applyFillToCash,
  closePositionAtPrice,
  createOpenPosition,
  pendingOrdersForBook,
  runMtmPass,
} from '../positionManager';
import { evaluateOrderRisk } from '../riskEngine';
import {
  findAccountByUser,
  findOrderByIdempotency,
  getPositionById,
  insertAccount,
  insertFill,
  insertOrder,
  insertPosition,
  insertRiskEvent,
  insertTradeLog,
  journalPaperTrade,
  listClosedPositions,
  listOpenPositions,
  listOrders,
  listRecentFills,
  listRiskEvents,
  logKillSwitch,
  updateAccountBalances,
  updateOrder,
  updatePosition,
  upsertRiskProfile,
  getRiskProfile,
} from '../repository/paperTradingRepository';
import type {
  PaperAccountSummary,
  PaperOrder,
  PaperPosition,
  PaperRiskConfig,
  PlaceOrderRequest,
} from '../types';
import { DEFAULT_PAPER_RISK } from '../types';

function todayIst(): string {
  const d = new Date();
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function resetDailyPnlIfNeeded(account: Awaited<ReturnType<typeof findAccountByUser>>) {
  if (!account) return;
  const today = todayIst();
  const { rows } = await import('@/lib/db').then((m) =>
    m.db.query(`SELECT daily_pnl_reset_at FROM paper_accounts WHERE id = ?`, [account.id]),
  );
  const resetAt = rows[0]?.daily_pnl_reset_at
    ? String(rows[0].daily_pnl_reset_at).slice(0, 10)
    : null;
  if (resetAt !== today) {
    await updateAccountBalances(account.id, { dailyPnl: 0, dailyPnlResetAt: today });
    account.dailyPnl = 0;
  }
}

export async function getOrCreateAccount(userId: number): Promise<PaperAccountSummary> {
  let account = await findAccountByUser(userId);
  if (!account) {
    account = await insertAccount(`pa_${uuidv4().slice(0, 12)}`, userId, DEFAULT_PAPER_RISK.virtualCapital);
  }
  await resetDailyPnlIfNeeded(account);
  account = (await findAccountByUser(userId))!;
  return buildSummary(account);
}

async function buildSummary(account: NonNullable<Awaited<ReturnType<typeof findAccountByUser>>>): Promise<PaperAccountSummary> {
  const openPositions = await listOpenPositions(account.id);
  const closedPositions = await listClosedPositions(account.id);
  const allOrders = await listOrders(account.id);
  const pendingOrders = pendingOrdersForBook(allOrders);
  const recentFills = await listRecentFills(account.id, 30);
  const exposure = openPositions.reduce(
    (s, p) => s + p.quantity * (p.currentPrice ?? p.entryPrice),
    0,
  );
  return {
    account,
    openPositions,
    closedPositions,
    pendingOrders,
    recentFills,
    mtm: {
      equity: account.equity,
      cashBalance: account.cashBalance,
      unrealizedPnl: account.unrealizedPnl,
      realizedPnl: account.realizedPnl,
      dailyPnl: account.dailyPnl,
      exposurePct: account.equity > 0 ? (exposure / account.equity) * 100 : 0,
    },
  };
}

async function resolveReferencePrice(symbol: string, ref?: number): Promise<number> {
  if (ref != null && ref > 0) return ref;
  const live = await getLivePrice(symbol);
  return live.price ?? 0;
}

async function resolvePriorClose(symbol: string): Promise<number | null> {
  const live = await getLivePrice(symbol);
  return live.close ?? null;
}

export async function placePaperOrder(
  userId: number,
  req: PlaceOrderRequest,
): Promise<{ ok: boolean; order?: PaperOrder; position?: PaperPosition; error?: string; code?: string }> {
  const account = await findAccountByUser(userId);
  if (!account) return { ok: false, error: 'Paper account not found', code: 'NO_ACCOUNT' };

  await resetDailyPnlIfNeeded(account);
  const freshAccount = (await findAccountByUser(userId))!;

  if (req.idempotencyKey) {
    const existing = await findOrderByIdempotency(freshAccount.id, req.idempotencyKey);
    if (existing) return { ok: true, order: existing };
  }

  const symbol = req.symbol.toUpperCase();
  const refPrice = await resolveReferencePrice(symbol, req.referencePrice);
  const openPositions = await listOpenPositions(freshAccount.id);
  const allOrders = await listOrders(freshAccount.id);
  const pendingOrders = pendingOrdersForBook(allOrders);
  const today = todayIst();
  const todayOrderCount = allOrders.filter((o) => String(o.createdAt).slice(0, 10) === today).length;
  const priorClose = await resolvePriorClose(symbol);

  const risk = evaluateOrderRisk(
    { ...req, symbol, referencePrice: refPrice },
    {
      account: freshAccount,
      openPositions,
      pendingOrders,
      priorClosePrice: priorClose,
      atrPct: null,
      todayOrderCount,
      killSwitchActive: isGlobalKillSwitchActive(),
      marketOpen: isMarketOpen(),
    },
  );

  const orderId = `ord_${uuidv4().slice(0, 12)}`;
  const now = new Date().toISOString();
  const baseOrder: PaperOrder = {
    id: orderId,
    accountId: freshAccount.id,
    symbol,
    side: req.side,
    orderType: req.orderType ?? 'MARKET',
    role: req.role ?? 'ENTRY',
    quantity: req.quantity,
    limitPrice: req.limitPrice ?? null,
    stopPrice: req.stopPrice ?? null,
    triggerPrice: req.triggerPrice ?? null,
    status: 'PENDING',
    strategyId: req.strategyId ?? null,
    filledQty: 0,
    idempotencyKey: req.idempotencyKey ?? null,
    createdAt: now,
    updatedAt: now,
  };

  if (!risk.allowed) {
    baseOrder.status = 'REJECTED';
    baseOrder.rejectReason = risk.message;
    await insertOrder(baseOrder);
    await insertRiskEvent({
      userId,
      accountId: freshAccount.id,
      eventType: 'ORDER_BLOCKED',
      code: risk.code,
      message: risk.message,
      symbol,
      strategyId: req.strategyId,
      blocked: true,
    });
    await insertTradeLog({
      accountId: freshAccount.id,
      userId,
      orderId,
      symbol,
      eventType: 'ORDER_REJECTED',
      side: req.side,
      quantity: req.quantity,
      strategyId: req.strategyId,
      details: { code: risk.code, message: risk.message },
    });
    return { ok: false, order: baseOrder, error: risk.message, code: risk.code };
  }

  const sim = simulateFill({
    side: req.side,
    orderType: baseOrder.orderType,
    quantity: req.quantity,
    referencePrice: refPrice,
    limitPrice: req.limitPrice,
    stopPrice: req.stopPrice,
    slippageBps: freshAccount.risk.slippageBps,
  });

  if (!sim.filled) {
    baseOrder.status = 'PENDING';
    await insertOrder(baseOrder);
    return { ok: true, order: baseOrder };
  }

  baseOrder.status = 'FILLED';
  baseOrder.filledQty = req.quantity;
  baseOrder.avgFillPrice = sim.fillPrice;
  await insertOrder(baseOrder);

  await insertFill({
    accountId: freshAccount.id,
    orderId,
    symbol,
    side: req.side,
    quantity: req.quantity,
    fillPrice: sim.fillPrice,
    slippageBps: sim.slippageBps,
    fees: sim.fees,
  });
  await insertTradeLog({
    accountId: freshAccount.id,
    userId,
    orderId,
    symbol,
    eventType: 'FILL',
    side: req.side,
    quantity: req.quantity,
    price: sim.fillPrice,
    fees: sim.fees,
    strategyId: req.strategyId,
  });

  let position: PaperPosition | undefined;
  let cash = freshAccount.cashBalance;
  let realized = freshAccount.realizedPnl;
  let dailyPnl = freshAccount.dailyPnl;
  let consecutive = freshAccount.consecutiveLosses;
  let unrealized = freshAccount.unrealizedPnl;

  if ((req.role ?? 'ENTRY') === 'ENTRY' && req.side === 'BUY') {
    cash = applyFillToCash(cash, 'BUY', req.quantity, sim.fillPrice, sim.fees);
    position = createOpenPosition({
      accountId: freshAccount.id,
      symbol,
      side: 'BUY',
      quantity: req.quantity,
      entryPrice: sim.fillPrice,
      stopLoss: req.stopLoss,
      takeProfit: req.takeProfit,
      strategyId: req.strategyId,
      entryOrderId: orderId,
    });
    baseOrder.positionId = position.id;
    await updateOrder(baseOrder);
    await insertPosition(position);
    await insertTradeLog({
      accountId: freshAccount.id,
      userId,
      orderId,
      positionId: position.id,
      symbol,
      eventType: 'POSITION_OPEN',
      side: req.side,
      quantity: req.quantity,
      price: sim.fillPrice,
      strategyId: req.strategyId,
    });
  } else if (req.role === 'EXIT' || req.side === 'SELL') {
    const open = openPositions.find((p) => p.symbol === symbol);
    if (open) {
      position = closePositionAtPrice(open, sim.fillPrice, 'MANUAL', orderId);
      const pnl = position.realizedPnl ?? 0;
      cash = applyFillToCash(cash, 'SELL', open.quantity, sim.fillPrice, sim.fees);
      realized += pnl - sim.fees;
      dailyPnl += pnl - sim.fees;
      consecutive = pnl < 0 ? consecutive + 1 : 0;
      await updatePosition(position);
      await journalPaperTrade(userId, position, sim.fees);
      await insertTradeLog({
        accountId: freshAccount.id,
        userId,
        orderId,
        positionId: position.id,
        symbol,
        eventType: 'POSITION_CLOSE',
        side: 'SELL',
        quantity: open.quantity,
        price: sim.fillPrice,
        pnl: position.realizedPnl ?? 0,
        fees: sim.fees,
        strategyId: open.strategyId ?? undefined,
        details: { reason: 'MANUAL' },
      });
    }
  }

  const openAfter = await listOpenPositions(freshAccount.id);
  unrealized = openAfter.reduce((s, p) => s + p.unrealizedPnl, 0);
  const holdings = openAfter.reduce(
    (s, p) => s + p.quantity * (p.currentPrice ?? p.entryPrice),
    0,
  );
  const equity = cash + holdings;

  await updateAccountBalances(freshAccount.id, {
    cashBalance: Math.round(cash * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    consecutiveLosses: consecutive,
  });

  return { ok: true, order: baseOrder, position };
}

export async function refreshMarkToMarket(userId: number): Promise<PaperAccountSummary> {
  const account = await findAccountByUser(userId);
  if (!account) throw new Error('Paper account not found');

  const positions = await listOpenPositions(account.id);
  const prices: Record<string, number> = {};
  for (const p of positions) {
    prices[p.symbol] = await resolveReferencePrice(p.symbol);
  }

  const mtm = runMtmPass(account, positions, prices);
  let cash = account.cashBalance;
  let realized = account.realizedPnl;
  let dailyPnl = account.dailyPnl;
  let consecutive = account.consecutiveLosses;

  for (const exit of mtm.exits) {
    const closed = closePositionAtPrice(exit.position, exit.exitPrice, exit.reason);
    const fees = 20;
    const pnl = (closed.realizedPnl ?? 0) - fees;
    cash = applyFillToCash(cash, 'SELL', closed.quantity, exit.exitPrice, fees);
    realized += pnl;
    dailyPnl += pnl;
    consecutive = pnl < 0 ? consecutive + 1 : 0;
    await updatePosition(closed);
    await journalPaperTrade(userId, closed, fees);
    await insertTradeLog({
      accountId: account.id,
      userId,
      positionId: closed.id,
      symbol: closed.symbol,
      eventType: 'POSITION_CLOSE',
      side: 'SELL',
      quantity: closed.quantity,
      price: exit.exitPrice,
      pnl: closed.realizedPnl ?? 0,
      fees,
      strategyId: closed.strategyId ?? undefined,
      details: { reason: exit.reason },
    });
  }

  for (const pos of mtm.positions) {
    await updatePosition(pos);
  }

  const openAfter = await listOpenPositions(account.id);
  const holdings = openAfter.reduce(
    (s, p) => s + p.quantity * (p.currentPrice ?? p.entryPrice),
    0,
  );

  await updateAccountBalances(account.id, {
    cashBalance: Math.round(cash * 100) / 100,
    equity: Math.round((cash + holdings) * 100) / 100,
    unrealizedPnl: Math.round(mtm.totalUnrealized * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    dailyPnl: Math.round(dailyPnl * 100) / 100,
    consecutiveLosses: consecutive,
  });

  return getOrCreateAccount(userId);
}

export async function closePaperPosition(
  userId: number,
  positionId: string,
  referencePrice?: number,
): Promise<{ ok: boolean; position?: PaperPosition; error?: string }> {
  const account = await findAccountByUser(userId);
  if (!account) return { ok: false, error: 'Paper account not found' };
  const pos = await getPositionById(positionId);
  if (!pos || pos.accountId !== account.id) return { ok: false, error: 'Position not found' };
  if (pos.status !== 'OPEN') return { ok: false, error: 'Position already closed' };

  const price = referencePrice ?? (await resolveReferencePrice(pos.symbol));
  const result = await placePaperOrder(userId, {
    symbol: pos.symbol,
    side: 'SELL',
    orderType: 'MARKET',
    role: 'EXIT',
    quantity: pos.quantity,
    referencePrice: price,
    strategyId: pos.strategyId ?? undefined,
  });
  return { ok: result.ok, position: result.position, error: result.error };
}

export async function getOrderBook(userId: number) {
  const account = await findAccountByUser(userId);
  if (!account) return { orders: [], market: getMarketStatus() };
  const orders = await listOrders(account.id);
  return { orders, market: getMarketStatus() };
}

export async function setKillSwitch(
  userId: number,
  activate: boolean,
  reason: string,
  actor: string,
): Promise<{ active: boolean; reason: string }> {
  const account = await findAccountByUser(userId);
  if (!account) throw new Error('Paper account not found');
  await updateAccountBalances(account.id, { killSwitchActive: activate });
  await logKillSwitch(account.id, userId, activate ? 'ACTIVATE' : 'DEACTIVATE', reason, actor);
  return { active: activate || isGlobalKillSwitchActive(), reason };
}

export async function getKillSwitchState(userId: number) {
  const account = await findAccountByUser(userId);
  const global = isGlobalKillSwitchActive();
  return {
    global,
    account: account?.killSwitchActive ?? false,
    active: global || (account?.killSwitchActive ?? false),
    market: getMarketStatus(),
  };
}

export async function deployToPaper(
  userId: number,
  strategyId: string,
  actor: string,
): Promise<{ ok: boolean; approved: boolean; issues: string[]; accountId?: string }> {
  const { getRegistryEntry, ACTIVE_RUNNER_STRATEGIES } = await import('@/lib/strategy-hub/registry');
  const registryEntry = getRegistryEntry(strategyId);
  let result: { approved: boolean; issues: string[] };

  if (registryEntry) {
    const [{ assessPaperTradingReadiness }, { loadStrategyProfile }] = await Promise.all([
      import('@/lib/strategy-hub/services/paperTradingReadiness'),
      import('@/lib/strategy-hub/repository/strategyProfiles'),
    ]);
    const profile = await loadStrategyProfile(strategyId);
    const readiness = assessPaperTradingReadiness(strategyId, {
      hasEvaluator: ACTIVE_RUNNER_STRATEGIES.has(registryEntry.strategyId),
      isActiveInRunner: ACTIVE_RUNNER_STRATEGIES.has(registryEntry.strategyId),
      profile,
    });
    result = {
      approved: readiness.ready,
      issues: readiness.checks
        .filter((check) => check.required && !check.pass)
        .map((check) => check.name),
    };
  } else {
    const { requestPaperDeployment } = await import('@/lib/strategy-lab');
    result = await requestPaperDeployment(strategyId, actor);
  }

  const account = await getOrCreateAccount(userId);
  if (result.approved) {
    await upsertRiskProfile(userId, account.account.id, account.account.risk);
    await insertTradeLog({
      accountId: account.account.id,
      userId,
      symbol: '—',
      eventType: 'STRATEGY_DEPLOY',
      strategyId,
      details: { deployment: 'paper' },
    });
  }
  return {
    ok: result.approved,
    approved: result.approved,
    issues: result.issues,
    accountId: account.account.id,
  };
}

export async function saveRiskSettings(
  userId: number,
  settings: Partial<PaperRiskConfig> & { killSwitchActive?: boolean },
) {
  const account = await getOrCreateAccount(userId);
  const profile = await upsertRiskProfile(userId, account.account.id, settings);
  if (settings.killSwitchActive != null) {
    await updateAccountBalances(account.account.id, { killSwitchActive: settings.killSwitchActive });
    await logKillSwitch(
      account.account.id,
      userId,
      settings.killSwitchActive ? 'ACTIVATE' : 'DEACTIVATE',
      'Risk settings update',
      'user',
    );
  }
  await insertRiskEvent({
    userId,
    accountId: account.account.id,
    eventType: 'SETTINGS_UPDATE',
    code: 'RISK_PROFILE',
    message: 'Risk profile updated',
    blocked: false,
    details: settings as Record<string, unknown>,
  });
  return { profile, account: await getOrCreateAccount(userId) };
}

export async function getRiskSettings(userId: number) {
  const account = await getOrCreateAccount(userId);
  let profile = await getRiskProfile(userId);
  if (!profile) {
    profile = await upsertRiskProfile(userId, account.account.id, account.account.risk);
  }
  const events = await listRiskEvents(userId, 20);
  return { profile, events, killSwitch: await getKillSwitchState(userId), account: account.account };
}
