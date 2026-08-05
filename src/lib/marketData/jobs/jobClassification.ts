/**
 * Phase 13 — Background job classification & system-broker gates.
 *
 * Jobs are reviewed separately from user live streams.
 * System-owned ingestion must use SYSTEM_MARKET_DATA_USER_ID only —
 * never the first row of broker_connections, never an arbitrary
 * logged-in customer connection applied globally.
 */

import {
  getSystemMarketDataUserId,
  isSystemFeedOwner,
} from '@/lib/marketData/systemFeed';
import type { DataSourceBroker } from '@/lib/broker/connections/types';

/** How a scheduled / background job relates to broker credentials. */
export type JobBrokerClass =
  /** Reads/writes app DB, news, universe — no broker tokens. */
  | 'broker_neutral_db'
  /** Process-global market ingest — requires explicit system service account. */
  | 'system_owned_ingestion'
  /** Per-user broker work (interactive or future user-scoped jobs). */
  | 'user_specific_broker';

export interface BackgroundJobSpec {
  id: string;
  label: string;
  class: JobBrokerClass;
  /** Rough schedule hint for ops. */
  schedule?: string;
  notes?: string;
}

/**
 * Canonical catalog — keep in sync with scheduler / server.js / instrumentation.
 * Not every timer must appear; every market/broker-adjacent job should.
 */
export const BACKGROUND_JOB_CATALOG: readonly BackgroundJobSpec[] = [
  // ── broker-neutral DB ──────────────────────────────────────────
  {
    id: 'daily-scan-db',
    label: 'Daily / evening signal scan (DB candles)',
    class: 'broker_neutral_db',
    schedule: '09:20 / 09:45 / 16:30 IST',
    notes: 'data_source=db — no broker API',
  },
  {
    id: 'signal-maturity',
    label: 'Signal maturity tracker',
    class: 'broker_neutral_db',
    schedule: 'every 60s',
    notes: 'Explicitly no resolveBatch / resolvePrices',
  },
  {
    id: 'manipulation-scan',
    label: 'Manipulation scan',
    class: 'broker_neutral_db',
    schedule: '18:30 IST',
  },
  {
    id: 'learning-scheduler',
    label: 'Learning / calibration',
    class: 'broker_neutral_db',
    schedule: '20:30 IST',
  },
  {
    id: 'nightly-backtest',
    label: 'Nightly backtest',
    class: 'broker_neutral_db',
    schedule: '19:00 IST',
  },
  {
    id: 'outcome-evaluation',
    label: 'Outcome evaluation',
    class: 'broker_neutral_db',
    schedule: '20:00 IST',
  },
  {
    id: 'feed-health-retention',
    label: 'Feed health retention',
    class: 'broker_neutral_db',
    schedule: '02:30 IST',
  },
  {
    id: 'weekly-universe',
    label: 'Weekly NSE1000 rebuild',
    class: 'broker_neutral_db',
    schedule: 'Sun 22:00 IST',
  },
  {
    id: 'news-ingestion',
    label: 'News ingestion',
    class: 'broker_neutral_db',
    notes: 'News APIs only — not broker market data',
  },

  // ── system-owned market ingestion ──────────────────────────────
  {
    id: 'candle-daily-update',
    label: 'Evening candle daily update (Kite)',
    class: 'system_owned_ingestion',
    schedule: '~16:00 IST',
    notes: 'Requires SYSTEM_MARKET_DATA_USER_ID Zerodha connection',
  },
  {
    id: 'candle-backfill',
    label: 'Candle backfill (Kite)',
    class: 'system_owned_ingestion',
    notes: 'Ops / scripts — system broker only',
  },
  {
    id: 'candle-refresh',
    label: 'Candle refresh scheduler',
    class: 'system_owned_ingestion',
    schedule: 'adaptive 5–30m',
  },
  {
    id: 'batch-tiers',
    label: 'Batch quote tiers / warmup / post-close',
    class: 'system_owned_ingestion',
    schedule: 'market hours',
    notes: 'MarketDataProvider + system Kite hydrate',
  },
  {
    id: 'live-market-feed',
    label: 'Process-global live market feed',
    class: 'system_owned_ingestion',
    notes: 'System feed key only — not per-customer',
  },
  {
    id: 'eod-bhavcopy',
    label: 'NSE bhavcopy EOD ingestion',
    class: 'system_owned_ingestion',
    schedule: '19:30 IST (+ evening fallback)',
    notes: 'No broker token; writes shared candles with source=nse_bhavcopy',
  },
  {
    id: 'snapshot-lifecycle',
    label: 'Confirmed snapshot lifecycle LTP',
    class: 'system_owned_ingestion',
    schedule: 'every 30s',
    notes: 'System resolvePrices — not user active broker',
  },
  {
    id: 'rescore',
    label: 'Signal rescore',
    class: 'system_owned_ingestion',
    notes: 'System resolvePrices when live LTP needed',
  },

  // ── user-specific (not cron; documented for contrast) ──────────
  {
    id: 'user-oauth-stream',
    label: 'User OAuth + per-user streaming',
    class: 'user_specific_broker',
    notes: 'Interactive /data-source — never used as global ingest credential',
  },
] as const;

export function listJobsByClass(jobClass: JobBrokerClass): BackgroundJobSpec[] {
  return BACKGROUND_JOB_CATALOG.filter((j) => j.class === jobClass);
}

export class SystemBrokerConfigError extends Error {
  readonly code:
    | 'SYSTEM_USER_UNSET'
    | 'SYSTEM_BROKER_MISSING'
    | 'SYSTEM_BROKER_INACTIVE'
    | 'SYSTEM_SESSION_MISMATCH';

  constructor(
    code: SystemBrokerConfigError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'SystemBrokerConfigError';
    this.code = code;
  }
}

/**
 * Fail closed: system-owned jobs need an explicit Quantorus service account id.
 */
export function requireSystemMarketDataUserId(): number {
  const id = getSystemMarketDataUserId();
  if (id == null) {
    throw new SystemBrokerConfigError(
      'SYSTEM_USER_UNSET',
      'SYSTEM_MARKET_DATA_USER_ID is required for system-owned market ingestion — '
        + 'refusing to use an arbitrary broker_connections row',
    );
  }
  return id;
}

export interface SystemBrokerConnectionSnapshot {
  userId: number;
  broker: DataSourceBroker;
  status: string;
  hasToken: boolean;
  accountId: string | null;
}

/**
 * Resolve the configured system broker connection for ingestion.
 * Never scans broker_connections without user_id; never LIMIT 1 across users.
 */
export async function requireSystemOwnedBrokerConnection(
  broker: DataSourceBroker = 'zerodha',
): Promise<SystemBrokerConnectionSnapshot> {
  const userId = requireSystemMarketDataUserId();

  const { getBrokerConnectionByUserAndBroker } = await import(
    '@/lib/broker/connections/repository'
  );
  const row = await getBrokerConnectionByUserAndBroker(userId, broker);
  if (!row) {
    throw new SystemBrokerConfigError(
      'SYSTEM_BROKER_MISSING',
      `No ${broker} broker_connections row for SYSTEM_MARKET_DATA_USER_ID=${userId}`,
    );
  }
  if (row.status !== 'active' || !row.accessTokenEncrypted) {
    throw new SystemBrokerConfigError(
      'SYSTEM_BROKER_INACTIVE',
      `System ${broker} connection for user ${userId} is ${row.status} or missing token — `
        + 'connect that service account on /data-source',
    );
  }

  return {
    userId,
    broker,
    status: row.status,
    hasToken: true,
    accountId: row.brokerAccountId,
  };
}

/**
 * Soft check for schedulers that should skip (not throw) when unset.
 */
export function isSystemOwnedIngestionConfigured(): boolean {
  return getSystemMarketDataUserId() != null;
}

/** True when a Redis/session payload may drive the global Kite client. */
export function isValidSystemSessionOwner(quantorusUserId: string | number): boolean {
  return isSystemFeedOwner(quantorusUserId);
}

export function getJobClassificationSummary(): Record<string, unknown> {
  const byClass = {
    broker_neutral_db: listJobsByClass('broker_neutral_db').map((j) => j.id),
    system_owned_ingestion: listJobsByClass('system_owned_ingestion').map((j) => j.id),
    user_specific_broker: listJobsByClass('user_specific_broker').map((j) => j.id),
  };
  return {
    systemMarketDataUserId: getSystemMarketDataUserId(),
    systemIngestionConfigured: isSystemOwnedIngestionConfigured(),
    jobs: byClass,
    rules: [
      'Never use first available broker_connections row',
      'Never apply a customer connection globally',
      'Candle multi-source writes require source precedence (candleSourcePolicy)',
    ],
  };
}
