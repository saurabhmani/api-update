/**
 * validateProviderRequestPolicy — removed vendor quota policy checks removed (Phase 3).
 * Candle job caps still live in providerRequestPolicy; reintroduce Kite-specific
 * checks here when needed.
 */
console.log('[validateProviderRequestPolicy] SKIP — removed vendor policy decommissioned');
process.exit(0);
