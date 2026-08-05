// Broker Integration Layer — paper trading + narrow legacy connection status.
// Market-data broker SDKs (Kite/Shoonya) are NOT re-exported from this barrel.

export * from './types';
export { getBrokerAdapter, registerBrokerAdapter, listBrokerAdapters, defaultBrokerName } from './adapter/registry';
export { connectBroker, refreshBrokerToken, getValidCredentials, getBrokerAuthStatus, disconnectBroker } from './auth/brokerAuth';
export { placeLiveOrder } from './services/liveOrderEngine';
export { deployLiveTrading } from './services/liveTradingDeploy';
export { syncBrokerOrders } from './services/orderSyncService';
export { syncBrokerPositions } from './services/positionSyncService';
export { evaluateLiveTradingGates } from './services/liveTradingGates';
export { checkBrokerHealth, getBrokerHealthReport } from './monitoring/brokerHealth';
export { isGlobalLiveKillSwitchActive, isLiveTradingEnabled } from './killSwitch';
export { withRetry } from './sdk/retry';
export { ensureBrokerTables, acceptDisclaimer, hasAcceptedDisclaimer } from './repository/brokerRepository';
export { LIVE_DISCLAIMER_VERSION, MIN_PAPER_TRADES_FOR_LIVE } from './types';

// Legacy data-source connection rows (ignored for market data; IndianAPI is sole upstream)
export {
  ensureBrokerConnectionTables,
  hasActiveBrokerConnection,
  getSafeBrokerStatus,
  resolvePostLoginDestination,
  getUserActiveDataSource,
  setUserActiveDataSource,
  disconnectDataSourceBroker,
  ActiveDataSourceError,
  encryptBrokerCredential,
  decryptBrokerCredential,
} from './connections';
export type { UserActiveDataSource } from './connections';
