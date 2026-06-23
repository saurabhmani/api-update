/**
 * IndianAPIAdapter — HTTP agent capacity vs emulated batch size (Tests 3.1–3.3).
 */
import { describe, expect, it } from 'vitest';
import { resolveIndianApiTransportCapacity } from '@/providers/adapters/IndianAPIAdapter';

describe('IndianAPIAdapter — transport capacity', () => {
  it('3.1 — INDIANAPI_EMULATED_BATCH_MAX=200 scales maxSockets to 200', () => {
    const { httpAgentMaxSockets } = resolveIndianApiTransportCapacity('200');
    expect(httpAgentMaxSockets).toBe(200);
  });

  it('3.2 — INDIANAPI_EMULATED_BATCH_MAX=10 keeps maxSockets at 25 floor', () => {
    const { httpAgentMaxSockets } = resolveIndianApiTransportCapacity('10');
    expect(httpAgentMaxSockets).toBe(25);
  });

  it('3.3 — unset env retains legacy maxSockets=25', () => {
    const { maxEmulatedBatchSymbols, httpAgentMaxSockets } = resolveIndianApiTransportCapacity(undefined);
    expect(maxEmulatedBatchSymbols).toBe(25);
    expect(httpAgentMaxSockets).toBe(25);
  });
});
