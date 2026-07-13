import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetLiveMarketFeedForTests,
  registerDemand,
  getLiveMarketFeedStats,
} from '@/lib/marketData/liveMarketFeed';

describe('liveMarketFeed', () => {
  beforeEach(() => {
    _resetLiveMarketFeedForTests();
  });

  it('registers symbol demand and tracks subscription count', () => {
    const added = registerDemand(['RELIANCE', 'TCS']);
    expect(added).toContain('RELIANCE');
    expect(added).toContain('TCS');
    const stats = getLiveMarketFeedStats();
    expect(stats.subscribedCount).toBe(2);
  });

  it('normalizes Upstox-style instrument keys', () => {
    const added = registerDemand(['NSE_EQ|INFY']);
    expect(added).toEqual(['INFY']);
  });
});
