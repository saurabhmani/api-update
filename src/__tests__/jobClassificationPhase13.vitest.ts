/**
 * Phase 13 — job classification + candle source precedence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_JOB_CATALOG,
  listJobsByClass,
  requireSystemMarketDataUserId,
  SystemBrokerConfigError,
  isValidSystemSessionOwner,
  getJobClassificationSummary,
} from '@/lib/marketData/jobs/jobClassification';
import {
  shouldApplyCandleUpsert,
  isWarehouseCandleSourceAllowed,
  candleSourcePrecedence,
} from '@/lib/marketData/jobs/candleSourcePolicy';

describe('job classification catalog', () => {
  it('classifies candle ingest as system_owned and scans as broker_neutral', () => {
    const systemIds = listJobsByClass('system_owned_ingestion').map((j) => j.id);
    const dbIds = listJobsByClass('broker_neutral_db').map((j) => j.id);
    expect(systemIds).toContain('candle-daily-update');
    expect(systemIds).toContain('live-market-feed');
    expect(dbIds).toContain('signal-maturity');
    expect(dbIds).toContain('manipulation-scan');
    expect(BACKGROUND_JOB_CATALOG.some((j) => j.class === 'user_specific_broker')).toBe(true);
  });

  it('summary exposes unset system user', () => {
    delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    const s = getJobClassificationSummary();
    expect(s.systemMarketDataUserId).toBeNull();
    expect(s.systemIngestionConfigured).toBe(false);
  });
});

describe('requireSystemMarketDataUserId', () => {
  const prev = process.env.SYSTEM_MARKET_DATA_USER_ID;

  afterEach(() => {
    if (prev === undefined) delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    else process.env.SYSTEM_MARKET_DATA_USER_ID = prev;
  });

  it('throws when unset', () => {
    delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    expect(() => requireSystemMarketDataUserId()).toThrow(SystemBrokerConfigError);
  });

  it('returns configured id', () => {
    process.env.SYSTEM_MARKET_DATA_USER_ID = '42';
    expect(requireSystemMarketDataUserId()).toBe(42);
    expect(isValidSystemSessionOwner(42)).toBe(true);
    expect(isValidSystemSessionOwner(7)).toBe(false);
  });
});

describe('candle source precedence', () => {
  beforeEach(() => {
    delete process.env.SYSTEM_ALLOW_SHOONYA_CANDLE_INGEST;
  });

  it('blocks shoonya from shared warehouse by default', () => {
    expect(isWarehouseCandleSourceAllowed('shoonya')).toBe(false);
    expect(
      shouldApplyCandleUpsert({ incoming: 'shoonya', existing: null }).apply,
    ).toBe(false);
  });

  it('nse_bhavcopy wins over kite; kite does not overwrite nse', () => {
    expect(candleSourcePrecedence('nse_bhavcopy')).toBeGreaterThan(
      candleSourcePrecedence('kite'),
    );
    expect(
      shouldApplyCandleUpsert({ incoming: 'nse_bhavcopy', existing: 'kite' }).apply,
    ).toBe(true);
    expect(
      shouldApplyCandleUpsert({ incoming: 'kite', existing: 'nse_bhavcopy' }).apply,
    ).toBe(false);
  });

  it('same source may refresh', () => {
    expect(
      shouldApplyCandleUpsert({ incoming: 'kite', existing: 'kite' }).apply,
    ).toBe(true);
  });
});

describe('requireSystemOwnedBrokerConnection', () => {
  const prev = process.env.SYSTEM_MARKET_DATA_USER_ID;

  afterEach(() => {
    if (prev === undefined) delete process.env.SYSTEM_MARKET_DATA_USER_ID;
    else process.env.SYSTEM_MARKET_DATA_USER_ID = prev;
    vi.resetModules();
  });

  it('refuses when system user has no zerodha row', async () => {
    process.env.SYSTEM_MARKET_DATA_USER_ID = '99';
    vi.doMock('@/lib/broker/connections/repository', () => ({
      getBrokerConnectionByUserAndBroker: vi.fn(async () => null),
    }));
    const { requireSystemOwnedBrokerConnection, SystemBrokerConfigError: Err } =
      await import('@/lib/marketData/jobs/jobClassification');
    await expect(requireSystemOwnedBrokerConnection('zerodha')).rejects.toBeInstanceOf(Err);
  });
});
