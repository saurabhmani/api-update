import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { createApiPerfTracker } from '@/lib/api/apiPerf';

describe('createApiPerfTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('records steps and finishes with total time', () => {
    const perf = createApiPerfTracker('/test');
    perf.mark('start');
    vi.advanceTimersByTime(50);
    perf.addSql('test.query', 30, 10);
    perf.setMeta('ok', true);
    expect(() => perf.finish()).not.toThrow();
    vi.useRealTimers();
  });
});
