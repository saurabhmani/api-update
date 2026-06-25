// Live Trading Gates — backtest, paper history, risk, disclaimer

import { evaluateOrderRisk } from '@/lib/paper-trading/riskEngine';
import { getOrCreateAccount } from '@/lib/paper-trading';
import { listOpenPositions, listOrders } from '@/lib/paper-trading/repository/paperTradingRepository';
import { pendingOrdersForBook } from '@/lib/paper-trading/positionManager';
import {
  countBacktestsPassed,
  countPaperTrades,
  hasAcceptedDisclaimer,
} from '../repository/brokerRepository';
import { getValidCredentials } from '../auth/brokerAuth';
import { isGlobalLiveKillSwitchActive } from '../killSwitch';
import type { LiveTradingGateResult } from '../types';
import { LIVE_DISCLAIMER_VERSION, MIN_PAPER_TRADES_FOR_LIVE } from '../types';

export async function evaluateLiveTradingGates(userId: number): Promise<LiveTradingGateResult> {
  const issues: string[] = [];

  const backtestCount = await countBacktestsPassed(userId);
  const backtestPassed = backtestCount > 0;
  if (!backtestPassed) issues.push('Backtest required before live trading');

  const paperTradeCount = await countPaperTrades(userId);
  const paperPassed = paperTradeCount >= MIN_PAPER_TRADES_FOR_LIVE;
  if (!paperPassed) {
    issues.push(`Minimum ${MIN_PAPER_TRADES_FOR_LIVE} paper trades required (have ${paperTradeCount})`);
  }

  const disclaimerPassed = await hasAcceptedDisclaimer(userId, LIVE_DISCLAIMER_VERSION);
  if (!disclaimerPassed) issues.push('User disclaimer must be accepted');

  const killPassed = !isGlobalLiveKillSwitchActive();
  if (!killPassed) issues.push('Global kill switch is active');

  const creds = await getValidCredentials(userId);
  const brokerPassed = creds.ok;
  if (!brokerPassed) issues.push(creds.error ?? 'Broker not connected');

  let riskPassed = true;
  let riskMessage = 'Risk validation available';
  try {
    const account = await getOrCreateAccount(userId);
    const openPositions = await listOpenPositions(account.account.id);
    const pendingOrders = pendingOrdersForBook(await listOrders(account.account.id));
    const probe = evaluateOrderRisk(
      { symbol: 'PROBE', side: 'BUY', quantity: 1, referencePrice: 100, stopLoss: 98 },
      {
        account: account.account,
        openPositions,
        pendingOrders,
        killSwitchActive: !killPassed || account.account.killSwitchActive,
        marketOpen: true,
      },
    );
    riskPassed = probe.allowed || probe.code !== 'KILL_SWITCH';
    riskMessage = riskPassed ? 'Risk engine operational' : probe.message;
    if (!riskPassed) issues.push(riskMessage);
  } catch {
    riskPassed = false;
    riskMessage = 'Risk validation failed';
    issues.push(riskMessage);
  }

  const gates = {
    backtest: { passed: backtestPassed, message: backtestPassed ? `${backtestCount} backtest(s) passed` : 'No passed backtest' },
    paperHistory: { passed: paperPassed, message: paperPassed ? `${paperTradeCount} paper trades` : `Need ${MIN_PAPER_TRADES_FOR_LIVE} paper trades` },
    riskValidation: { passed: riskPassed, message: riskMessage },
    disclaimer: { passed: disclaimerPassed, message: disclaimerPassed ? 'Disclaimer accepted' : 'Disclaimer required' },
    killSwitch: { passed: killPassed, message: killPassed ? 'Kill switch off' : 'Kill switch active' },
    brokerConnected: { passed: brokerPassed, message: brokerPassed ? 'Broker connected' : (creds.error ?? 'Not connected') },
  };

  return {
    allowed: issues.length === 0,
    gates,
    issues,
  };
}
