/**
 * Deterministic fingerprint for SignalFeatures — used by Phase 1
 * consistency tests. Pure JSON stable sort; no crypto required.
 */
import type { SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function fingerprintSignalFeatures(features: SignalFeatures): string {
  return stableStringify(features);
}
