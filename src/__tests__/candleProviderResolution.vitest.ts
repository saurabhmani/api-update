import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/marketData/providerResolution', () => ({
  resolveSystemMarketDataProvider: vi.fn(),
}));

import { resolveSystemMarketDataProvider } from '@/lib/marketData/providerResolution';
import { ensureCandleIngestConfigured } from '@/lib/marketData/jobs/candleIngestBroker';

const resolveSystem = vi.mocked(resolveSystemMarketDataProvider);

describe('candle ingest provider gate', () => {
  it('accepts IndianAPI-only historical candle configuration without a broker', async () => {
    resolveSystem.mockResolvedValue({
      ok: true, code: 'resolved', provider: 'indianapi', providerKind: 'indianapi',
      capability: 'historical_candles', fallbackUsed: true, fallbackReason: 'no_connected_provider',
      active: null, connectedProviders: [],
    });
    const gate = await ensureCandleIngestConfigured();
    expect(gate).toMatchObject({ ok: true, ingest: null, provider: 'indianapi' });
    expect(gate.message).toContain('IndianAPI fallback');
  });
});
