import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  WEEKLY_UNIVERSE_REBUILD_CRON_DEFAULT,
  resolveWeeklyUniverseRebuildCron,
  isWeeklyUniverseRebuildEnabled,
} from '@/lib/marketData/weeklyUniverseSchedule';

describe('weeklyUniverseSchedule', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it('defaults to Sunday 22:00 IST cron', () => {
    delete process.env.UNIVERSE_WEEKLY_REBUILD_CRON;
    expect(resolveWeeklyUniverseRebuildCron()).toBe(WEEKLY_UNIVERSE_REBUILD_CRON_DEFAULT);
    expect(WEEKLY_UNIVERSE_REBUILD_CRON_DEFAULT).toBe('0 22 * * 0');
  });

  it('allows Monday 08:00 IST via env override', () => {
    process.env.UNIVERSE_WEEKLY_REBUILD_CRON = '0 8 * * 1';
    expect(resolveWeeklyUniverseRebuildCron()).toBe('0 8 * * 1');
  });

  it('is enabled by default and can be disabled via env', () => {
    delete process.env.UNIVERSE_WEEKLY_REBUILD_ENABLED;
    expect(isWeeklyUniverseRebuildEnabled()).toBe(true);
    process.env.UNIVERSE_WEEKLY_REBUILD_ENABLED = 'false';
    expect(isWeeklyUniverseRebuildEnabled()).toBe(false);
  });
});
