// Live feed state — provider-aware freshness (Phase 8)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  classifyLiveFeedQuality,
  recordLiveFeedTick,
  recordLiveFeedPollStart,
  recordLiveFeedPollSuccess,
  liveFeedBlocksApprovals,
  resolveActiveCandleSource,
  getLiveFeedStateFor,
  setLiveFeedConnectionPhase,
  liveFeedReferenceTime,
  _resetLiveFeedStateForTests,
  type LiveFeedKey,
} from '@/lib/marketData/liveFeedState';

vi.mock('@/lib/marketData/marketHours', () => ({
  isMarketOpen: vi.fn(() => true),
}));

import { isMarketOpen } from '@/lib/marketData/marketHours';

const A_Z: LiveFeedKey = { userId: '1', provider: 'zerodha' };
const B_S: LiveFeedKey = { userId: '2', provider: 'shoonya' };
const A_S: LiveFeedKey = { userId: '1', provider: 'shoonya' };

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
    recordLiveFeedTick(Date.now() - 130_000);
    expect(classifyLiveFeedQuality()).toBe('stale');
    expect(liveFeedBlocksApprovals()).toBe(true);
    expect(resolveActiveCandleSource()).toBe('daily');
  });

  it('stays fresh when vendor quote timestamp is delayed but receipt is recent', () => {
    recordLiveFeedPollStart(10);
    recordLiveFeedPollSuccess();
    const now = Date.now();
    recordLiveFeedTick(now, now - 900_000);
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
    recordLiveFeedTick(Date.now() - 300_000);
    recordLiveFeedPollSuccess();
    expect(classifyLiveFeedQuality()).toBe('fresh');
    expect(liveFeedBlocksApprovals()).toBe(false);
  });

  it('prefers a newer tick over an older poll success', () => {
    recordLiveFeedPollStart(10);
    const now = Date.now();
    recordLiveFeedPollSuccess();
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

describe('liveFeedState keyed freshness (Phase 8)', () => {
  beforeEach(() => {
    _resetLiveFeedStateForTests();
    vi.mocked(isMarketOpen).mockReturnValue(true);
  });

  it('uses referenceTime = max(valid lastReceivedAt, valid lastSuccessAt)', () => {
    expect(
      liveFeedReferenceTime({ lastReceivedAt: 100, lastSuccessAt: 200 }),
    ).toBe(200);
    expect(
      liveFeedReferenceTime({ lastReceivedAt: 300, lastSuccessAt: 200 }),
    ).toBe(300);
    expect(
      liveFeedReferenceTime({ lastReceivedAt: null, lastSuccessAt: 50 }),
    ).toBe(50);
    expect(
      liveFeedReferenceTime({ lastReceivedAt: 0, lastSuccessAt: undefined }),
    ).toBe(0);
  });

  it('auth/connect alone must not mark a source as fresh', () => {
    setLiveFeedConnectionPhase(A_Z, 'connecting');
    expect(getLiveFeedStateFor(A_Z).status).toBe('connecting');

    setLiveFeedConnectionPhase(A_Z, 'connected');
    const afterAuth = getLiveFeedStateFor(A_Z);
    expect(afterAuth.status).toBe('waiting_for_data');
    expect(afterAuth.lastReceivedAt).toBeUndefined();
    expect(afterAuth.lastSuccessAt).toBeUndefined();
  });

  it("user A's Shoonya feed is not freshened by user B's Zerodha tick", () => {
    setLiveFeedConnectionPhase(A_S, 'connected');
    setLiveFeedConnectionPhase(B_S, 'connected');
    setLiveFeedConnectionPhase(A_Z, 'connected');

    recordLiveFeedTick(Date.now(), undefined, { userId: '99', provider: 'zerodha' });

    expect(getLiveFeedStateFor(A_S).status).toBe('waiting_for_data');
    expect(getLiveFeedStateFor(B_S).status).toBe('waiting_for_data');
    expect(getLiveFeedStateFor({ userId: '99', provider: 'zerodha' }).status).toBe('fresh');
  });

  it('isolates providers for the same user', () => {
    recordLiveFeedTick(Date.now(), undefined, A_Z);
    expect(getLiveFeedStateFor(A_Z).status).toBe('fresh');
    expect(getLiveFeedStateFor(A_S).status).toBe('not_connected');

    setLiveFeedConnectionPhase(A_S, 'connected');
    expect(getLiveFeedStateFor(A_S).status).toBe('waiting_for_data');
    expect(getLiveFeedStateFor(A_Z).status).toBe('fresh');
  });

  it('login_required is per connection key', () => {
    setLiveFeedConnectionPhase(A_Z, 'login_required', 'session expired');
    recordLiveFeedTick(Date.now(), undefined, B_S);
    expect(getLiveFeedStateFor(A_Z).status).toBe('login_required');
    expect(getLiveFeedStateFor(B_S).status).toBe('fresh');
    expect(liveFeedBlocksApprovals(Date.now(), A_Z)).toBe(true);
    expect(liveFeedBlocksApprovals(Date.now(), B_S)).toBe(false);
  });

  it('stale on one key does not block approvals on another', () => {
    recordLiveFeedTick(Date.now() - 130_000, undefined, A_Z);
    recordLiveFeedTick(Date.now(), undefined, B_S);
    expect(getLiveFeedStateFor(A_Z).status).toBe('stale');
    expect(getLiveFeedStateFor(B_S).status).toBe('fresh');
    expect(liveFeedBlocksApprovals(Date.now(), A_Z)).toBe(true);
    expect(liveFeedBlocksApprovals(Date.now(), B_S)).toBe(false);
  });
});
