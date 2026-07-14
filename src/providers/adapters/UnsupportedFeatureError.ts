// ════════════════════════════════════════════════════════════════
//  UnsupportedFeatureError — provider methods Kite cannot serve
// ════════════════════════════════════════════════════════════════

/**
 * Thrown by `KiteAdapter` (and future vendors) for endpoints that are
 * part of `IMarketDataProvider` / the removed vendor surface but have no
 * Zerodha Kite Connect equivalent (news, movers, corporate intel, …).
 *
 * Callers that later wire Kite into MarketDataProvider should catch
 * this and fall through to removed vendor / cache / empty — never treat it
 * as a transient network failure.
 */
export class UnsupportedFeatureError extends Error {
  readonly provider = 'kite' as const;
  readonly feature: string;

  constructor(feature: string, detail?: string) {
    const message = detail
      ? `KiteAdapter: unsupported feature "${feature}" — ${detail}`
      : `KiteAdapter: unsupported feature "${feature}"`;
    super(message);
    this.name = 'UnsupportedFeatureError';
    this.feature = feature;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      feature: this.feature,
      message: this.message,
    };
  }
}

/** Always throws — use at unsupported method bodies. */
export function unsupported(feature: string, detail?: string): never {
  throw new UnsupportedFeatureError(feature, detail);
}
