/**
 * Phase 13 — Shared warehouse candle source rules.
 *
 * Precedence (higher wins on conflict):
 *   nse_bhavcopy  100  — official exchange EOD
 *   indianapi      90  — sole active upstream ingest
 *   kite           80  — legacy rows only (no new writes preferred)
 *   shoonya        0   — blocked from shared warehouse by default
 *   yahoo          20  — emergency only
 *   unknown        10
 */

export type WarehouseCandleSource =
  | 'kite'
  | 'nse_bhavcopy'
  | 'shoonya'
  | 'indianapi'
  | 'yahoo'
  | 'unknown';

const PRECEDENCE: Record<WarehouseCandleSource, number> = {
  nse_bhavcopy: 100,
  indianapi: 90,
  /** Legacy Zerodha historical rows — kept for upsert conflict rules only. */
  kite: 80,
  shoonya: 0,
  yahoo: 20,
  unknown: 10,
};

export function candleSourcePrecedence(source: WarehouseCandleSource): number {
  return PRECEDENCE[source] ?? 0;
}

export function normalizeWarehouseCandleSource(
  raw: string | null | undefined,
): WarehouseCandleSource {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'kite' || v === 'zerodha') return 'kite';
  if (v === 'nse_bhavcopy' || v === 'nse' || v === 'bhavcopy') return 'nse_bhavcopy';
  if (v === 'shoonya') return 'shoonya';
  if (v === 'indianapi') return 'indianapi';
  if (v === 'yahoo') return 'yahoo';
  return 'unknown';
}

/** Whether this source may write the shared `candles` warehouse. */
export function isWarehouseCandleSourceAllowed(
  source: WarehouseCandleSource,
): boolean {
  if (source === 'shoonya') {
    const allow = (process.env.SYSTEM_ALLOW_SHOONYA_CANDLE_INGEST ?? '').trim().toLowerCase();
    return allow === '1' || allow === 'true' || allow === 'yes' || allow === 'on';
  }
  // Kite/Zerodha no longer write new warehouse rows on the main path.
  if (source === 'kite') {
    const allow = (process.env.SYSTEM_ALLOW_KITE_CANDLE_INGEST ?? '').trim().toLowerCase();
    return allow === '1' || allow === 'true' || allow === 'yes' || allow === 'on';
  }
  return source === 'nse_bhavcopy' || source === 'indianapi'
    || source === 'yahoo' || source === 'unknown';
}

/**
 * Decide if an incoming bar may overwrite an existing warehouse row.
 * Same source may refresh OHLC; lower-precedence sources never overwrite higher.
 */
export function shouldApplyCandleUpsert(input: {
  incoming: WarehouseCandleSource;
  existing: WarehouseCandleSource | null | undefined;
}): { apply: boolean; reason: string } {
  if (!isWarehouseCandleSourceAllowed(input.incoming)) {
    return {
      apply: false,
      reason: `source_${input.incoming}_blocked_from_shared_warehouse`,
    };
  }

  if (input.existing == null || input.existing === 'unknown') {
    return { apply: true, reason: 'no_existing_or_unknown' };
  }

  const inScore = candleSourcePrecedence(input.incoming);
  const exScore = candleSourcePrecedence(input.existing);

  if (inScore > exScore) {
    return { apply: true, reason: 'higher_precedence' };
  }
  if (inScore === exScore) {
    return { apply: true, reason: 'same_source_refresh' };
  }
  return {
    apply: false,
    reason: `keep_existing_${input.existing}_over_${input.incoming}`,
  };
}

/** SQL fragment helpers — source column may be absent on older DBs until migrated. */
export const CANDLE_SOURCE_COLUMN = 'source';
