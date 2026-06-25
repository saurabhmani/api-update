import './loadEnv';
// Paper Trading Engine — unit tests (no DB required)

import { v4 as uuidv4 } from 'uuid';
import { simulateFill, checkExitTriggers, computeUnrealizedPnl, applySlippage } from '../lib/paper-trading/orderSimulator';
import { evaluateOrderRisk, sizingFromRisk } from '../lib/paper-trading/riskEngine';
import { isGlobalKillSwitchActive, shouldBlockTrading } from '../lib/paper-trading/killSwitch';
import {
  createOpenPosition,
  markPositionMtm,
  closePositionAtPrice,
  runMtmPass,
  applyFillToCash,
} from '../lib/paper-trading/positionManager';
import { DEFAULT_PAPER_RISK, type PaperAccount } from '../lib/paper-trading/types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

function mockAccount(overrides: Partial<PaperAccount> = {}): PaperAccount {
  return {
    id: 'pa_test',
    userId: 1,
    name: 'Test',
    virtualCapital: 1_000_000,
    cashBalance: 900_000,
    equity: 1_000_000,
    realizedPnl: 0,
    unrealizedPnl: 50_000,
    risk: { ...DEFAULT_PAPER_RISK },
    consecutiveLosses: 0,
    dailyPnl: 0,
    killSwitchActive: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Paper Trading Engine — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  // Order Simulator
  const marketBuy = simulateFill({ side: 'BUY', orderType: 'MARKET', quantity: 10, referencePrice: 100, slippageBps: 10 });
  check('Market BUY fills', marketBuy.filled === true, `price=${marketBuy.fillPrice}`);
  check('Market BUY slippage applied', marketBuy.fillPrice > 100, `price=${marketBuy.fillPrice}`);

  const limitNoFill = simulateFill({ side: 'BUY', orderType: 'LIMIT', quantity: 10, referencePrice: 105, limitPrice: 100 });
  check('Limit BUY not filled when above limit', !limitNoFill.filled, '');

  const limitFill = simulateFill({ side: 'BUY', orderType: 'LIMIT', quantity: 10, referencePrice: 99, limitPrice: 100 });
  check('Limit BUY fills when at/below limit', limitFill.filled === true, `price=${limitFill.fillPrice}`);

  const stopBuy = simulateFill({ side: 'BUY', orderType: 'STOP', quantity: 10, referencePrice: 102, stopPrice: 100 });
  check('Stop BUY triggers', stopBuy.filled === true, '');

  check('Slippage helper', applySlippage(100, 'SELL', 10) < 100, '');

  // SL/TP triggers
  const slHit = checkExitTriggers('BUY', 95, 96, 120);
  check('Stop loss triggers on long', slHit.exit && slHit.reason === 'STOP_LOSS', '');
  const tpHit = checkExitTriggers('BUY', 125, 96, 120);
  check('Take profit triggers on long', tpHit.exit && tpHit.reason === 'TAKE_PROFIT', '');

  // PnL
  const pnl = computeUnrealizedPnl('BUY', 10, 100, 110);
  check('Unrealized PnL long', pnl === 100, `pnl=${pnl}`);

  // Risk Engine
  const acct = mockAccount();
  const baseReq = { symbol: 'RELIANCE', side: 'BUY' as const, quantity: 10, referencePrice: 2500, stopLoss: 2450 };
  const pass = evaluateOrderRisk(baseReq, {
    account: acct,
    openPositions: [],
    pendingOrders: [],
    killSwitchActive: false,
    marketOpen: true,
  });
  check('Risk passes clean order', pass.allowed, pass.message);

  const kill = evaluateOrderRisk(baseReq, {
    account: { ...acct, killSwitchActive: true },
    openPositions: [],
    pendingOrders: [],
    killSwitchActive: true,
    marketOpen: true,
  });
  check('Kill switch blocks', !kill.allowed && kill.code === 'KILL_SWITCH', '');

  const closed = evaluateOrderRisk(baseReq, {
    account: acct,
    openPositions: [],
    pendingOrders: [],
    killSwitchActive: false,
    marketOpen: false,
  });
  check('Market closed blocks market order', !closed.allowed && closed.code === 'MARKET_CLOSED', '');

  const maxPos = evaluateOrderRisk(baseReq, {
    account: acct,
    openPositions: Array(5).fill(null).map((_, i) => ({
      id: `p${i}`, accountId: 'pa_test', symbol: `SYM${i}`, side: 'BUY' as const,
      quantity: 1, entryPrice: 100, unrealizedPnl: 0, status: 'OPEN' as const,
      openedAt: '', updatedAt: '',
    })),
    pendingOrders: [],
    killSwitchActive: false,
    marketOpen: true,
  });
  check('Max positions blocks', !maxPos.allowed && maxPos.code === 'MAX_POSITIONS', '');

  const dupKey = evaluateOrderRisk(
    { ...baseReq, idempotencyKey: 'key-1' },
    {
      account: acct,
      openPositions: [],
      pendingOrders: [{
        id: 'o1', accountId: 'pa_test', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET',
        role: 'ENTRY', quantity: 10, status: 'SUBMITTED', filledQty: 0,
        idempotencyKey: 'key-1', createdAt: '', updatedAt: '',
      }],
      killSwitchActive: false,
      marketOpen: true,
    },
  );
  check('Duplicate idempotency blocked', !dupKey.allowed && dupKey.code === 'DUPLICATE_ORDER', '');

  const circuit = evaluateOrderRisk(baseReq, {
    account: acct,
    openPositions: [],
    pendingOrders: [],
    priorClosePrice: 2700,
    killSwitchActive: false,
    marketOpen: true,
  });
  check('Circuit breaker on large drop', !circuit.allowed && circuit.code === 'CIRCUIT_BREAKER', '');

  const size = sizingFromRisk(1_000_000, 100, 98, DEFAULT_PAPER_RISK);
  check('Position sizing from risk', size > 0, `qty=${size}`);

  // Position Manager
  const pos = createOpenPosition({
    accountId: 'pa_test', symbol: 'INFY', side: 'BUY', quantity: 20,
    entryPrice: 1500, stopLoss: 1450, takeProfit: 1600, entryOrderId: 'ord_1',
  });
  check('Create position', pos.status === 'OPEN' && pos.symbol === 'INFY', '');

  const mtm = markPositionMtm(pos, 1550);
  check('MTM updates unrealized', mtm.unrealizedPnl === 1000, `pnl=${mtm.unrealizedPnl}`);

  const closedPos = closePositionAtPrice(pos, 1600, 'TAKE_PROFIT');
  check('Close position realizes PnL', closedPos.status === 'CLOSED' && closedPos.realizedPnl === 2000, '');

  const mtmPass = runMtmPass(acct, [pos], { INFY: 1440 });
  check('MTM pass detects SL', mtmPass.exits.length === 1 && mtmPass.exits[0].reason === 'STOP_LOSS', '');

  const cashAfterBuy = applyFillToCash(1_000_000, 'BUY', 10, 100, 20);
  check('Cash reduced on buy', cashAfterBuy < 1_000_000, `cash=${cashAfterBuy}`);

  // Kill switch
  const prev = process.env.PAPER_KILL_SWITCH;
  process.env.PAPER_KILL_SWITCH = '1';
  check('Global kill switch env', isGlobalKillSwitchActive(), '');
  process.env.PAPER_KILL_SWITCH = prev;
  const block = shouldBlockTrading(mockAccount(), false);
  check('shouldBlockTrading inactive', !block.active, '');

  // Summary
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed);
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (failed.length) {
    console.error('\nFailed:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('\n✅ Paper Trading tests passed\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
