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
export { parseBrokerTokenExpiry, toMysqlUtcDateTime, isBrokerTokenExpired } from './expiry';
export {
  classifyProviderFailure,
  shouldPersistCredentialDemotion,
  isConfirmedShoonyaCredentialInvalid,
  isConfirmedKiteCredentialInvalid,
  TEMPORARY_PROVIDER_FAILURES,
  CREDENTIAL_PROVIDER_FAILURES,
} from './providerFailure';
export type {
  ProviderFailureCategory,
  ClassifyProviderFailureInput,
} from './providerFailure';
export {
  setCredentialStatus,
  expireCredentialIfPastExpiry,
  applyProviderFailureToCredentialStatus,
  repairMisclassifiedExpiredCredential,
  isCredentialUsable,
  effectiveCredentialStatus,
} from './credentialStatus';
export type {
  SetCredentialStatusInput,
  CredentialStatusChangeReason,
  CredentialStatusChangeResult,
} from './credentialStatus';
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
