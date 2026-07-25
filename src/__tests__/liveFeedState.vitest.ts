// Live feed state classifier tests
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  classifyLiveFeedQuality,
  recordLiveFeedTick,
  recordLiveFeedPollStart,
  recordLiveFeedPollSuccess,
  liveFeedBlocksApprovals,
  resolveActiveCandleSource,
  _resetLiveFeedStateForTests,
} from '@/lib/marketData/liveFeedState';

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
}));

import { isMarketOpen } from '@/lib/marketData/marketHours';

describe('liveFeedState', () => {
  beforeEach(() => {
    _resetLiveFeedStateForTests();
    vi.mocked(isMarketOpen).mockReturnValue(true);
  });

  it('classifies fresh when tick is recent', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedPollSuccess();
    recordLiveFeedTick(Date.now());
    expect(classifyLiveFeedQuality()).toBe('fresh');
    expect(liveFeedBlocksApprovals()).toBe(false);
    expect(resolveActiveCandleSource()).toBe('live_tick');
  });

  it('classifies stale and blocks approvals after threshold', () => {
    recordLiveFeedPollStart(10);
    // Aged tick with no recent poll heartbeat → stale.
    recordLiveFeedTick(Date.now() - 130_000);
    expect(classifyLiveFeedQuality()).toBe('stale');
    expect(liveFeedBlocksApprovals()).toBe(true);
    expect(resolveActiveCandleSource()).toBe('daily');
  });

  it('stays fresh when vendor quote timestamp is delayed but receipt is recent', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedPollSuccess();
    const now = Date.now();
    recordLiveFeedTick(now, now - 900_000); // Yahoo ~15 min delayed quote
    expect(classifyLiveFeedQuality(now)).toBe('fresh');
    expect(liveFeedBlocksApprovals(now)).toBe(false);
  });

  it('uses lastSuccessAt when no ticks received yet but polls succeed', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedPollSuccess();
    expect(classifyLiveFeedQuality()).toBe('fresh');
  });

  it('prefers recent poll success over an aged lastReceivedAt (post-reconnect)', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedTick(Date.now() - 300_000); // old tick from before reconnect
    recordLiveFeedPollSuccess(); // fresh REST poll after OAuth
    expect(classifyLiveFeedQuality()).toBe('fresh');
    expect(liveFeedBlocksApprovals()).toBe(false);
  });

  it('returns closed_market off-hours', () => {
    vi.mocked(isMarketOpen).mockReturnValue(false);
    expect(classifyLiveFeedQuality()).toBe('closed_market');
    expect(resolveActiveCandleSource()).toBe('daily');
  });
});
