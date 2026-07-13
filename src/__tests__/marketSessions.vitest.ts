import { describe, expect, it } from 'vitest';
import { getSessionStatus, validateSessionForSignalGeneration } from '@/lib/platform/marketSessionEngine';
import { getAssetById } from '@/lib/platform/assetRegistry';
import { resolveAssetForSymbol } from '@/lib/platform/assetRegistry';

describe('market sessions', () => {
  it('returns 24x7 session for crypto', () => {
    const crypto = getAssetById('CRYPTO:BTCUSD')!;
    const status = getSessionStatus(crypto, new Date('2026-01-11T12:00:00Z'));
    expect(status.sessionType).toBe('twenty_four_seven');
    expect(status.isTradable).toBe(true);
  });

  it('blocks metadata-only options', () => {
    const opt = getAssetById('NSE:NIFTY_OPT')!;
    const validation = validateSessionForSignalGeneration(opt);
    expect(validation.allowed).toBe(false);
  });

  it('allows equity signal generation when market closed (EOD parity)', () => {
    const eq = resolveAssetForSymbol('RELIANCE');
    const validation = validateSessionForSignalGeneration(eq, new Date('2026-01-11T20:00:00Z'));
    expect(validation.allowed).toBe(true);
  });
});
