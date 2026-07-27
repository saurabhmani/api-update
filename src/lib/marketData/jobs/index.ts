export {
  BACKGROUND_JOB_CATALOG,
  listJobsByClass,
  requireSystemMarketDataUserId,
  requireSystemOwnedBrokerConnection,
  isSystemOwnedIngestionConfigured,
  isValidSystemSessionOwner,
  getJobClassificationSummary,
  SystemBrokerConfigError,
} from './jobClassification';
export type {
  JobBrokerClass,
  BackgroundJobSpec,
  SystemBrokerConnectionSnapshot,
} from './jobClassification';

export {
  resolveCandleIngestBroker,
  ensureCandleIngestConfigured,
  fetchConnectedBrokerDailyCandles,
  isConnectedBrokerCandleIngestEnabled,
} from './candleIngestBroker';
export type {
  CandleIngestBroker,
  CandleIngestFetchResult,
} from './candleIngestBroker';

export {
  candleSourcePrecedence,
  normalizeWarehouseCandleSource,
  isWarehouseCandleSourceAllowed,
  shouldApplyCandleUpsert,
  CANDLE_SOURCE_COLUMN,
} from './candleSourcePolicy';
export type { WarehouseCandleSource } from './candleSourcePolicy';

export {
  ensureCandlesSourceColumn,
  upsertWarehouseCandle,
} from './candleWarehouseUpsert';
export type {
  CandleUpsertOutcome,
  UpsertWarehouseCandleInput,
} from './candleWarehouseUpsert';
