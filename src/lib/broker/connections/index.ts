export * from './types';
export {
  ensureBrokerConnectionTables,
  getBrokerConnectionByUserAndBroker,
  getBrokerConnectionById,
  listBrokerConnectionsForUser,
  getPrimaryActiveBrokerConnection,
  upsertBrokerConnectionRecord,
  markBrokerConnectionStatus,
  setPrimaryDataSourceBroker,
  mergeBrokerConnectionMetadata,
  markRemainingConnectionsNeedSelection,
  getDecryptedAccessTokenForUser,
} from './repository';
export {
  createBrokerAuthTransaction,
  consumeBrokerAuthTransaction,
  createBrokerOAuthState,
  completeBrokerAuthTransaction,
  failBrokerAuthTransaction,
  findRecentCompletedAuthTransaction,
} from './authTransactions';
export {
  encryptBrokerCredential,
  decryptBrokerCredential,
  validateBrokerTokenEncryptionKey,
} from './encryption';
export { parseBrokerTokenExpiry, toMysqlUtcDateTime } from './expiry';
export {
  getSafeBrokerStatus,
  hasActiveBrokerConnection,
  resolveActiveBrokerConnection,
  resolvePostLoginDestination,
  brokerDisplayName,
  getUserActiveDataSource,
  setUserActiveDataSource,
  disconnectDataSourceBroker,
  getUserBrokerMarketDataProvider,
  resolvePrimaryFlagOnConnect,
  ActiveDataSourceError,
} from './status';
export type {
  UserActiveDataSource,
  ActiveDataSourceReason,
  ActiveDataSourceErrorCode,
  PostLoginDestination,
} from './status';
export {
  requireAuthenticatedActiveDataSource,
  isNextResponse as isActiveDataSourceGateResponse,
} from './requireActiveDataSource';
export {
  resolveUserMarketDataContext,
  resolveOptionalUserMarketMeta,
  resolveUserFeedMeta,
  providerDataJson,
  withProviderMeta,
  isMarketApiGateResponse,
  instrumentFromQuery,
  refreshFeedStatus,
  labelCandleDataOrigin,
} from './userMarketApi';
export type {
  UserMarketDataContext,
  ProviderDataEnvelope,
  ProviderResponseStatus,
} from './userMarketApi';
export {
  resolveUserLiveProvider,
  mapBrokerFetchError,
  brokerErrorCode,
} from './userProviderResolution';
export type {
  UserLiveResolution,
  UserLiveResolutionCode,
  UserFacingProviderStatus,
} from './userProviderResolution';
export {
  migrateLegacyBrokerDataForUser,
  migrateAllLegacyBrokerConnections,
} from './migrate';
