import { describe, expect, it } from 'vitest';
import {
  buildSignalResponseSource,
  hasUsableClosedSignalTiers,
  mapClosedLoaderToDataSource,
  selectPrimaryClosedSignals,
} from '@/lib/signals/signalResponseSource';
import {
  classifyMarketDataStatus,
  getStatus,
} from '@/lib/marketData/marketSessionService';
import {
  filterDisplayableApproved,
  getDisplayableApprovedVetoReasons,
} from '@/lib/signals/filterDisplayableApproved';

describe('marketSessionService', () => {
  it('marks weekend as weekend (Asia/Kolkata)', async () => {
    // 2026-07-25 was Saturday IST
    const sat = new Date('2026-07-25T08:00:00.000Z'); // 13:30 IST Saturday
    const session = await getStatus({ exchange: 'NSE', at: sat });
    expect(session.status).toBe('weekend');
    expect(session.isOpen).toBe(false);
  });

  it('marks a weekday mid-session as open', async () => {
    // 2026-07-24 Friday 10:00 IST = 04:30 UTC
    const friOpen = new Date('2026-07-24T04:30:00.000Z');
    const session = await getStatus({ exchange: 'NSE', at: friOpen });
    expect(session.status).toBe('open');
    expect(session.isOpen).toBe(true);
  });

  it('marks post-close weekday as closed', async () => {
    // 2026-07-24 Friday 16:00 IST = 10:30 UTC
    const friClosed = new Date('2026-07-24T10:30:00.000Z');
    const session = await getStatus({ exchange: 'NSE', at: friClosed });
    expect(session.status).toBe('closed');
    expect(session.isOpen).toBe(false);
  });

  it('classifies broker+closed as closed_market, not error', () => {
    expect(
      classifyMarketDataStatus({
        brokerConnected: true,
        marketOpen: false,
        lastTickAt: null,
      }),
    ).toBe('closed_market');
  });

  it('classifies broker+open+no tick as connected_no_data', () => {
    expect(
      classifyMarketDataStatus({
        brokerConnected: true,
        marketOpen: true,
        lastTickAt: null,
      }),
    ).toBe('connected_no_data');
  });
});

describe('signalResponseSource fallback', () => {
  it('maps persisted signals ahead of historical snapshot', () => {
    expect(
      mapClosedLoaderToDataSource({
        hasPersistedSignals: true,
        hasMarketCloseSnapshot: true,
        marketOpen: false,
      }),
    ).toBe('persisted');
  });

  it('maps snapshot-only to historical', () => {
    expect(
      mapClosedLoaderToDataSource({
        hasPersistedSignals: false,
        hasMarketCloseSnapshot: true,
        marketOpen: false,
      }),
    ).toBe('historical');
  });

  it('returns none only when nothing exists', () => {
    expect(
      mapClosedLoaderToDataSource({
        hasPersistedSignals: false,
        hasMarketCloseSnapshot: false,
        marketOpen: false,
      }),
    ).toBe('none');
  });

  it('builds stale metadata for closed persisted signals', () => {
    const src = buildSignalResponseSource({
      marketStatus: 'weekend',
      marketOpen: false,
      hasPersistedSignals: true,
      hasMarketCloseSnapshot: true,
      signalGeneratedAt: '2026-07-24T10:00:05.000Z',
      tradingDate: '2026-07-24',
      nowMs: Date.parse('2026-07-25T10:00:05.000Z'),
    });
    expect(src.dataSource).toBe('persisted');
    expect(src.isStale).toBe(true);
    expect(src.mode).toBe('stale');
    expect(src.tradingDate).toBe('2026-07-24');
    expect(src.ageMs).toBe(86_400_000);
    expect(src.emptyReason).toBeNull();
  });

  it('selects high_potential when approved empty', () => {
    const selected = selectPrimaryClosedSignals({
      approved: [],
      highPotential: [{ id: 1 }],
      developing: [{ id: 2 }],
      scanner: [],
      watchlist: [],
    });
    expect(selected.from).toBe('high_potential');
    expect(selected.rows).toHaveLength(1);
  });

  it('hasUsableClosedSignalTiers is true when only scanner exists', () => {
    expect(
      hasUsableClosedSignalTiers({
        approved: [],
        highPotential: [],
        developing: [],
        scanner: [{ id: 1 }],
        watchlist: [],
      }),
    ).toBe(true);
  });
});

describe('filterDisplayableApproved historical mode', () => {
  it('hides relaxed rows in live mode', () => {
    const reasons = getDisplayableApprovedVetoReasons(
      { is_relaxed: true },
      'RELAXED',
    );
    expect(reasons).toContain('is_relaxed');
  });

  it('keeps relaxed/conditional rows when allowHistorical', () => {
    const rows = filterDisplayableApproved(
      [
        { symbol: 'TCS', is_relaxed: true, is_conditional: true },
        { symbol: 'INFY', execution_allowed: false },
      ],
      'RELAXED',
      { allowHistorical: true },
    );
    expect(rows.map((r) => r.symbol)).toEqual(['TCS']);
  });
});
