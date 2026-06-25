// Paper Trading Engine — public exports

export * from './types';
export { simulateFill, checkExitTriggers, computeUnrealizedPnl } from './orderSimulator';
export { evaluateOrderRisk, sizingFromRisk } from './riskEngine';
export { isGlobalKillSwitchActive, shouldBlockTrading } from './killSwitch';
export {
  getOrCreateAccount,
  placePaperOrder,
  refreshMarkToMarket,
  closePaperPosition,
  getOrderBook,
  setKillSwitch,
  getKillSwitchState,
  deployToPaper,
  saveRiskSettings,
  getRiskSettings,
} from './services/paperTradingService';
export { ensurePaperTradingTables } from './repository/paperTradingRepository';
