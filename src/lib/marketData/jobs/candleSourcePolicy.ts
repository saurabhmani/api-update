/**
 * Phase 13 — Shared warehouse candle source rules.
 *
 * Multiple writers (system Kite, NSE bhavcopy, future Shoonya) must not
 * blindly overwrite the same (instrument_key, candle_type, interval, ts).
 *
 * Precedence (higher wins on conflict):
 *   nse_bhavcopy  100  — official exchange EOD
 *   kite           80  — system Zerodha historical (SYSTEM_MARKET_DATA_USER_ID)
 *   shoonya        0   — blocked from shared warehouse by default
 *   yahoo          20  — emergency only
 *   unknown        10
 *
 * Shoonya (or any user broker) must not write shared candles unless
 * SYSTEM_ALLOW_SHOONYA_CANDLE_INGEST=1 AND the job is explicitly
 * classified as system_owned with a system Shoonya service account.
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
  kite: 80,
  /** Connected Shoonya ingest (enabled via CANDLE_INGEST_USE_CONNECTED_BROKER / SYSTEM_ALLOW_SHOONYA_CANDLE_INGEST). */
  shoonya: 70,
  /** IndianAPI /historical_data is close-only (OHLC collapse to close) —
   *  never overwrite real OHLCV from bhavcopy / Kite / Shoonya. */
  indianapi: 40,
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
    if (allow === '1' || allow === 'true' || allow === 'yes' || allow === 'on') return true;
    // Single-tenant / connected-broker ingest path (default on).
    const connected = (process.env.CANDLE_INGEST_USE_CONNECTED_BROKER ?? '1').trim().toLowerCase();
    return connected === '1' || connected === 'true' || connected === 'yes' || connected === 'on';
  }
  return source === 'kite' || source === 'nse_bhavcopy' || source === 'indianapi'
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
