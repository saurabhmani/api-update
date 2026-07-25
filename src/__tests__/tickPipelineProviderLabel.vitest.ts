import { describe, expect, it } from 'vitest';
import { normalizedTickToLegacyTick, normalizedTickToMarketStream } from '@/lib/marketData/connectionManager/tickPipeline';
import type { NormalizedTick } from '@/lib/marketData/brokerProvider/types';

function tick(provider: 'zerodha' | 'shoonya'): NormalizedTick {
  return {
    provider,
    userId: '7',
    instrumentKey: 'NSE_EQ|RELIANCE',
    exchange: 'NSE',
    symbol: 'RELIANCE',
    brokerToken: '2885',
    lastPrice: 2500,
    close: 2480,
    receivedAt: new Date().toISOString(),
  };
}

describe('tickPipeline provider labeling', () => {
  it('keeps Shoonya ticks labeled shoonya (never yahoo/kite)', () => {
    const legacy = normalizedTickToLegacyTick(tick('shoonya'));
    const stream = normalizedTickToMarketStream(tick('shoonya'));
    expect(legacy.source).toBe('shoonya');
    expect(stream.source).toBe('shoonya');
  });

  it('keeps Zerodha ticks labeled zerodha', () => {
    const legacy = normalizedTickToLegacyTick(tick('zerodha'));
    const stream = normalizedTickToMarketStream(tick('zerodha'));
    expect(legacy.source).toBe('zerodha');
    expect(stream.source).toBe('zerodha');
  });
});
