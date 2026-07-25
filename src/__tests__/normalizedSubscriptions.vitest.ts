import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/kite/instruments', () => ({
  getInstrumentBySymbol: vi.fn(async () => null),
  downloadInstruments: vi.fn(async () => []),
}));

describe('normalized instrument identity + mappings', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { clearInstrumentMasterCache, upsertMasterRowForTests, __resetAllSubscriptionBooksForTests } =
      await import('@/lib/marketData/brokerProvider/instruments');
    clearInstrumentMasterCache();
    __resetAllSubscriptionBooksForTests();

    upsertMasterRowForTests({
      instrumentKey: 'NSE_EQ|RELIANCE',
      exchange: 'NSE',
      symbol: 'RELIANCE',
      instrumentType: 'EQ',
      zerodhaInstrumentToken: 738561,
      shoonyaExchangeToken: '2885',
      name: 'RELIANCE INDUSTRIES',
    });
    upsertMasterRowForTests({
      instrumentKey: 'BSE_EQ|RELIANCE',
      exchange: 'BSE',
      symbol: 'RELIANCE',
      instrumentType: 'EQ',
      zerodhaInstrumentToken: 128061444,
      shoonyaExchangeToken: '500325',
      name: 'RELIANCE BSE',
    });
    upsertMasterRowForTests({
      instrumentKey: 'NSE_INDEX|NIFTY 50',
      exchange: 'NSE',
      symbol: 'NIFTY 50',
      instrumentType: 'INDEX',
      zerodhaInstrumentToken: 256265,
      shoonyaExchangeToken: '26000',
      name: 'NIFTY 50',
    });
    upsertMasterRowForTests({
      instrumentKey: 'NFO|NIFTY25JULFUT',
      exchange: 'NFO',
      symbol: 'NIFTY25JULFUT',
      instrumentType: 'FUT',
      zerodhaInstrumentToken: 12345678,
      shoonyaExchangeToken: '99901',
      name: 'NIFTY FUT',
    });
    upsertMasterRowForTests({
      instrumentKey: 'NFO|NIFTY25JUL24000CE',
      exchange: 'NFO',
      symbol: 'NIFTY25JUL24000CE',
      instrumentType: 'CE',
      zerodhaInstrumentToken: 12345679,
      shoonyaExchangeToken: '99902',
      name: 'NIFTY CE',
    });
  });

  it('builds and parses instrumentKey for EQ / INDEX / F&O', async () => {
    const { toInstrumentKey, parseInstrumentKey, normalizeInstrument } = await import(
      '@/lib/marketData/brokerProvider/instruments'
    );

    expect(toInstrumentKey('NSE', 'reliance')).toBe('NSE_EQ|RELIANCE');
    expect(toInstrumentKey('BSE', 'RELIANCE')).toBe('BSE_EQ|RELIANCE');
    expect(toInstrumentKey('NSE', 'NIFTY 50', 'INDEX')).toBe('NSE_INDEX|NIFTY 50');
    expect(toInstrumentKey('NFO', 'NIFTY25JULFUT', 'FUT')).toBe('NFO|NIFTY25JULFUT');

    expect(parseInstrumentKey('NSE_EQ|RELIANCE')).toMatchObject({
      exchange: 'NSE',
      symbol: 'RELIANCE',
      instrumentType: 'EQ',
    });
    expect(parseInstrumentKey('NSE_INDEX|NIFTY 50').instrumentType).toBe('INDEX');
    expect(parseInstrumentKey('NFO|NIFTY25JUL24000CE').instrumentType).toBe('CE');

    const n = normalizeInstrument({ symbol: 'INFY', exchange: 'NSE' });
    expect(n.instrumentKey).toBe('NSE_EQ|INFY');
    expect(n.symbol).toBe('INFY');
  });

  it('maps NSE/BSE/INDEX/F&O to distinct Zerodha vs Shoonya tokens', async () => {
    const { mapToZerodhaInstrument, mapToShoonyaInstrument } = await import(
      '@/lib/marketData/brokerProvider/instruments'
    );

    const z = await mapToZerodhaInstrument({ symbol: 'RELIANCE', exchange: 'NSE' });
    const s = await mapToShoonyaInstrument({ symbol: 'RELIANCE', exchange: 'NSE' });
    expect(z.instrumentToken).toBe(738561);
    expect(s.token).toBe('2885');
    expect(z.instrumentToken).not.toBe(Number(s.token));
    expect(s.scripKey).toBe('NSE|2885');

    const zb = await mapToZerodhaInstrument({ exchange: 'BSE', symbol: 'RELIANCE' });
    const sb = await mapToShoonyaInstrument({ exchange: 'BSE', symbol: 'RELIANCE' });
    expect(zb.instrumentToken).toBe(128061444);
    expect(sb.token).toBe('500325');

    const zi = await mapToZerodhaInstrument({
      instrumentKey: 'NSE_INDEX|NIFTY 50',
    });
    expect(zi.instrumentToken).toBe(256265);

    const zf = await mapToZerodhaInstrument({
      exchange: 'NFO',
      symbol: 'NIFTY25JULFUT',
      instrumentType: 'FUT',
    });
    const sf = await mapToShoonyaInstrument({
      exchange: 'NFO',
      symbol: 'NIFTY25JULFUT',
      instrumentType: 'FUT',
    });
    expect(zf.instrumentToken).toBe(12345678);
    expect(sf.token).toBe('99901');

    const zo = await mapToZerodhaInstrument({
      exchange: 'NFO',
      symbol: 'NIFTY25JUL24000CE',
      instrumentType: 'CE',
    });
    expect(zo.instrumentToken).toBe(12345679);
  });

  it('throws explicit errors for missing mappings', async () => {
    const { mapToZerodhaInstrument, mapToShoonyaInstrument, BrokerMarketDataError } = await import(
      '@/lib/marketData/brokerProvider'
    );

    await expect(
      mapToZerodhaInstrument({ symbol: 'DOESNOTEXIST', exchange: 'NSE' }),
    ).rejects.toMatchObject({ code: 'instrument_unresolved' });

    await expect(
      mapToShoonyaInstrument({ symbol: 'DOESNOTEXIST', exchange: 'NSE' }, null),
    ).rejects.toBeInstanceOf(BrokerMarketDataError);
  });

  it('deduplicates subscriptions and isolates per user/provider', async () => {
    const {
      mapToZerodhaInstrument,
      mapToShoonyaInstrument,
      getSubscriptionBook,
    } = await import('@/lib/marketData/brokerProvider/instruments');

    const z = await mapToZerodhaInstrument({ symbol: 'RELIANCE', exchange: 'NSE' });
    const s = await mapToShoonyaInstrument({ symbol: 'RELIANCE', exchange: 'NSE' });

    const bookA = getSubscriptionBook(1, 'zerodha');
    const bookB = getSubscriptionBook(2, 'zerodha');
    const bookS = getSubscriptionBook(1, 'shoonya');

    const d1 = bookA.applySubscribe([
      { instrument: z.instrument, brokerRef: String(z.instrumentToken) },
      { instrument: z.instrument, brokerRef: String(z.instrumentToken) },
    ]);
    expect(d1.added).toHaveLength(1);
    expect(d1.already).toHaveLength(1);

    bookB.applySubscribe([
      { instrument: z.instrument, brokerRef: String(z.instrumentToken) },
    ]);
    bookS.applySubscribe([
      { instrument: s.instrument, brokerRef: s.scripKey },
    ]);

    expect(bookA.size()).toBe(1);
    expect(bookB.size()).toBe(1);
    expect(bookS.size()).toBe(1);
    expect(bookA.listBrokerRefs()[0]).toBe('738561');
    expect(bookS.listBrokerRefs()[0]).toBe('NSE|2885');
    expect(bookA.listBrokerRefs()[0]).not.toBe(bookS.listBrokerRefs()[0]);

    // Unsub user1 zerodha must not clear user2 or shoonya
    bookA.applyUnsubscribe([z.instrument.instrumentKey]);
    expect(bookA.size()).toBe(0);
    expect(bookB.size()).toBe(1);
    expect(bookS.size()).toBe(1);
  });

  it('dedupes broker refs on Zerodha connection instance (reconnect book)', async () => {
    process.env.KITE_API_KEY = 'testkey';
    const { ZerodhaConnectionInstance } = await import(
      '@/lib/marketData/connectionManager/zerodhaInstance'
    );
    const inst = new ZerodhaConnectionInstance({ userId: '9', provider: 'zerodha' });
    await inst.authenticate({ accessToken: 'tok' });
    await inst.subscribe(['738561', '738561', '295321']);
    expect(inst.getSnapshot().subscriptionCount).toBe(2);
  });
});
