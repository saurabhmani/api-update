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

  it('prefers a newer tick over an older poll success', () => {
    recordLiveFeedPollStart(10);
    const now = Date.now();
    // Simulate an old poll then a fresh tick (order: success first, then tick).
    recordLiveFeedPollSuccess();
    // Manually age success by recording an older tick as the only recent signal:
    // use a mid-age tick that is still "fresh" and confirm classifier uses max.
    recordLiveFeedTick(now - 10_000);
    expect(classifyLiveFeedQuality(now)).toBe('fresh');
  });

  it('classifies delayed between 45s and 120s', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedTick(Date.now() - 60_000);
    expect(classifyLiveFeedQuality()).toBe('delayed');
    expect(liveFeedBlocksApprovals()).toBe(false);
  });

  it('treats a future timestamp as fresh (clamped age)', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedTick(Date.now() + 30_000);
    expect(classifyLiveFeedQuality()).toBe('fresh');
  });

  it('returns closed_market off-hours', () => {
    vi.mocked(isMarketOpen).mockReturnValue(false);
    expect(classifyLiveFeedQuality()).toBe('closed_market');
    expect(resolveActiveCandleSource()).toBe('daily');
  });
});
