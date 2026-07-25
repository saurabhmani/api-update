/**
 * Broker connection ownership (Phase 5).
 *
 * @see ./types.ts for ConnectionKey / BrokerConnectionInstance
 * @see ./systemFeed.ts for SYSTEM_MARKET_DATA_USER_ID rules
 */

export type {
  ConnectionKey,
  BrokerConnectionState,
  BrokerConnectionSnapshot,
  BrokerConnectionInstance,
} from './types';

export {
  connectionKeyString,
  parseConnectionKey,
} from './types';

export {
  getSystemMarketDataUserId,
  isSystemFeedOwner,
  shouldUpdateSystemKiteFeed,
} from './systemFeed';

export {
  acquireBrokerConnection,
  getBrokerConnection,
  releaseBrokerConnection,
  upsertUserBrokerSession,
  listBrokerConnectionSnapshots,
  __resetBrokerConnectionRegistryForTests,
} from './registry';

export {
  StreamingLifecycle,
  classifyStreamError,
  reconnectDelayMs,
  MAX_RECONNECT_ATTEMPTS,
} from './streamingLifecycle';

export { publishNormalizedLiveTick } from './tickPipeline';
