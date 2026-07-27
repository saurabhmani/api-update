import { describe, expect, it } from 'vitest';
import {
  assertBrokerMarketDataContract,
  getBrokerMarketDataProvider,
  listBrokerMarketDataProviders,
  toInstrumentKey,
  toShoonyaScripKey,
} from '@/lib/marketData/brokerProvider';
import {
  kiteCandleToNormalized,
  kiteQuoteToNormalized,
  kiteTickToNormalized,
} from '@/lib/marketData/brokerProvider/zerodha/convert';
import {
  parseShoonyaChartTime,
  shoonyaCandleToNormalized,
  shoonyaQuoteToNormalized,
  shoonyaTouchlineToNormalized,
} from '@/lib/marketData/brokerProvider/shoonya/convert';
import { isSessionExpiryMessage } from '@/lib/marketData/brokerProvider/connectionHelpers';
import type { NormalizedTick } from '@/lib/marketData/brokerProvider';

describe('BrokerMarketDataProvider contract', () => {
  it('registers zerodha and shoonya with identical required capabilities', () => {
    const names = listBrokerMarketDataProviders().map((p) => p.name).sort();
    expect(names).toEqual(['shoonya', 'zerodha']);

    for (const provider of listBrokerMarketDataProviders()) {
      assertBrokerMarketDataContract(provider);
      expect(typeof provider.connect).toBe('function');
      expect(typeof provider.disconnect).toBe('function');
      expect(typeof provider.isConnected).toBe('function');
      expect(typeof provider.subscribe).toBe('function');
      expect(typeof provider.unsubscribe).toBe('function');
      expect(typeof provider.fetchQuote).toBe('function');
      expect(typeof provider.fetchHistoricalCandles).toBe('function');
      expect(typeof provider.getStatus).toBe('function');
      expect(typeof provider.onTick).toBe('function');
    }
  });

  it('aliases kite → zerodha provider', () => {
    expect(getBrokerMarketDataProvider('kite').name).toBe('zerodha');
    expect(getBrokerMarketDataProvider('zerodha').name).toBe('zerodha');
    expect(getBrokerMarketDataProvider('shoonya').name).toBe('shoonya');
  });

  it('onTick returns an unsubscribe and never leaks vendor fields', () => {
    const received: NormalizedTick[] = [];
    const zerodha = getBrokerMarketDataProvider('zerodha');
    const unsub = zerodha.onTick((tick) => {
      received.push(tick);
      expect(tick).not.toHaveProperty('instrument_token');
      expect(tick).not.toHaveProperty('susertoken');
      expect(tick.provider).toMatch(/zerodha|shoonya/);
    });
    expect(typeof unsub).toBe('function');
    unsub();
    expect(received).toEqual([]);
  });
});

describe('Normalized converters', () => {
  it('builds shared instrument keys', () => {
    expect(toInstrumentKey('NSE', 'reliance')).toBe('NSE_EQ|RELIANCE');
    expect(toShoonyaScripKey('nse', 2885)).toBe('NSE|2885');
  });

  it('maps kite quotes and candles to normalized shapes', () => {
    const quote = kiteQuoteToNormalized('NSE:RELIANCE', {
      instrument_token: 738561,
      timestamp: '2024-01-15T10:00:00+05:30',
      last_trade_time: null,
      last_price: 2500,
      volume: 1000,
      average_price: 2490,
      buy_quantity: 1,
      sell_quantity: 1,
      last_quantity: 1,
      ohlc: { open: 2480, high: 2510, low: 2470, close: 2495 },
      net_change: 5,
      lower_circuit_limit: 0,
      upper_circuit_limit: 0,
      oi: 0,
      oi_day_high: 0,
      oi_day_low: 0,
      depth: { buy: [], sell: [] },
    });
    expect(quote.symbol).toBe('RELIANCE');
    expect(quote.exchange).toBe('NSE');
    expect(quote.ltp).toBe(2500);
    expect(quote.open).toBe(2480);
    expect(quote.quality).toBe('live');

    const candle = kiteCandleToNormalized({
      date: new Date('2024-01-15T03:45:00.000Z'),
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
    });
    expect(candle.ts).toContain('2024-01-15');
    expect(candle.close).toBe(1.5);

    const tick = kiteTickToNormalized({
      tick: {
        token: 738561,
        symbol: 'RELIANCE',
        lastPrice: 2501,
        open: 2480,
        ts: Date.parse('2024-01-15T10:00:00Z'),
        source: 'kite',
      },
      userId: '42',
      exchange: 'NSE',
    });
    expect(tick.provider).toBe('zerodha');
    expect(tick.instrumentKey).toBe('NSE_EQ|RELIANCE');
    expect(tick.brokerToken).toBe('738561');
    expect(tick.lastPrice).toBe(2501);
    expect(tick.userId).toBe('42');
  });

  it('maps shoonya quotes, candles, and touchline to the same NormalizedTick shape', () => {
    const quote = shoonyaQuoteToNormalized(
      { exch: 'NSE', tsym: 'RELIANCE-EQ', lp: '2500', o: '2480', h: '2510', l: '2470', c: '2495', v: '100' },
      { symbol: 'RELIANCE', exchange: 'NSE' },
    );
    expect(quote.ltp).toBe(2500);
    expect(quote.symbol).toBe('RELIANCE');

    expect(parseShoonyaChartTime('15/01/2024 10:15:00')).toMatch(/2024-01-15/);
    // EOD date-only is IST midnight → previous calendar day in UTC.
    expect(parseShoonyaChartTime('09-JAN-2023')).toBe('2023-01-08T18:30:00.000Z');
    const candle = shoonyaCandleToNormalized({
      time: '15/01/2024 10:15:00',
      into: '1',
      inth: '2',
      intl: '0.5',
      intc: '1.5',
      intv: '9',
    });
    expect(candle.close).toBe(1.5);
    expect(candle.volume).toBe(9);

    const eod = shoonyaCandleToNormalized({
      time: '09-JAN-2023',
      into: '336.95',
      inth: '341.30',
      intl: '336.15',
      intc: '338.05',
      ssboe: '1673222400',
      intv: '10618786.00',
    });
    expect(eod.close).toBe(338.05);
    expect(eod.ts).toBe(new Date(1673222400 * 1000).toISOString());

    const tick = shoonyaTouchlineToNormalized({
      raw: { e: 'NSE', tk: '2885', lp: '2501', bp1: '2500', sp1: '2502', o: '2480' },
      userId: '7',
      symbol: 'RELIANCE',
      exchange: 'NSE',
      brokerToken: '2885',
    });
    expect(tick.provider).toBe('shoonya');
    expect(tick.instrumentKey).toBe('NSE_EQ|RELIANCE');
    expect(tick.bid).toBe(2500);
    expect(tick.ask).toBe(2502);
    expect(tick.receivedAt).toBeTruthy();
  });

  it('detects session-expiry style messages', () => {
    expect(isSessionExpiryMessage('Session Expired : 1')).toBe(true);
    expect(isSessionExpiryMessage('Invalid Session')).toBe(true);
    expect(isSessionExpiryMessage('rate limit')).toBe(false);
  });
});
