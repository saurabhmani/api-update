// Broker Integration Layer — public exports

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

// Data-source login (Zerodha / Shoonya)
export {
  ensureBrokerConnectionTables,
  hasActiveBrokerConnection,
  getSafeBrokerStatus,
  resolvePostLoginDestination,
  getUserActiveDataSource,
  setUserActiveDataSource,
  disconnectDataSourceBroker,
  getUserBrokerMarketDataProvider,
  ActiveDataSourceError,
  encryptBrokerCredential,
  decryptBrokerCredential,
} from './connections';
export type { UserActiveDataSource } from './connections';
export { getDataSourceBrokerAdapter } from './oauth/registry';

// Broker-scoped market-data providers (Phase 2 contract)
export {
  getBrokerMarketDataProvider,
  listBrokerMarketDataProviders,
  BrokerMarketDataError,
} from '@/lib/marketData/brokerProvider';
export type {
  BrokerMarketDataProvider,
  BrokerProviderName,
  BrokerConnectionContext,
  NormalizedInstrument,
  NormalizedInstrumentInput,
  NormalizedQuote,
  NormalizedCandle,
  NormalizedTick,
  ProviderConnectionStatus,
} from '@/lib/marketData/brokerProvider';
