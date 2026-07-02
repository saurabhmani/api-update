import { describe, it, expect } from 'vitest';
import { scoreUniverseCandidate } from '@/lib/marketData/nseUniverseRanker';
import {
  CONTROLLED_SIGNAL_CRONS,
  isPreopenCandleWarmupEnabled,
  isSignalIntradayRegenEnabled,
  isSignalsAutoRecoveryAllowedOnRead,
  isSignalsAutoRecoveryEnabled,
} from '@/lib/signal-engine/schedule/signalSchedulePolicy';

describe('signalSchedulePolicy', () => {
  it('defaults optional full scans and auto-recovery to disabled', () => {
    const prev = {
      preopen: process.env.PREOPEN_CANDLE_WARMUP_ENABLED,
      regen: process.env.SIGNAL_INTRADAY_REGEN_ENABLED,
      recovery: process.env.SIGNALS_AUTO_RECOVERY_ENABLED,
      recoveryRead: process.env.SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ,
    };
    delete process.env.PREOPEN_CANDLE_WARMUP_ENABLED;
    delete process.env.SIGNAL_INTRADAY_REGEN_ENABLED;
    delete process.env.SIGNALS_AUTO_RECOVERY_ENABLED;
    delete process.env.SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ;
    expect(isPreopenCandleWarmupEnabled()).toBe(false);
    expect(isSignalIntradayRegenEnabled()).toBe(false);
    expect(isSignalsAutoRecoveryEnabled()).toBe(false);
    expect(isSignalsAutoRecoveryAllowedOnRead()).toBe(false);
    if (prev.preopen !== undefined) process.env.PREOPEN_CANDLE_WARMUP_ENABLED = prev.preopen;
    if (prev.regen !== undefined) process.env.SIGNAL_INTRADAY_REGEN_ENABLED = prev.regen;
    if (prev.recovery !== undefined) process.env.SIGNALS_AUTO_RECOVERY_ENABLED = prev.recovery;
    if (prev.recoveryRead !== undefined) {
      process.env.SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ = prev.recoveryRead;
    }
  });

  it('defines controlled IST cron defaults', () => {
    expect(CONTROLLED_SIGNAL_CRONS.readinessCheck).toBe('30 8 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.firstMorningScan).toBe('20 9 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.mainMorningScan).toBe('45 9 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.middayRescore).toBe('30 12 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.lateRescore).toBe('45 14 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.eveningUpdate).toBe('0 16 * * 1-5');
    expect(CONTROLLED_SIGNAL_CRONS.eveningScan).toBe('30 16 * * 1-5');
  });
});

describe('nseUniverseRanker', () => {
  it('ranks higher traded value and completeness above thin symbols', () => {
    const maxTv = 1_000_000;
    const liquid = scoreUniverseCandidate({
      tradedValue: 900_000,
      volumeConsistency: 0.9,
      candleCompleteness: 0.95,
      maxTradedValue: maxTv,
    });
    const thin = scoreUniverseCandidate({
      tradedValue: 10_000,
      volumeConsistency: 0.2,
      candleCompleteness: 0.1,
      maxTradedValue: maxTv,
    });
    expect(liquid).toBeGreaterThan(thin);
  });
});
