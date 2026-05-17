// ════════════════════════════════════════════════════════════════
//  Options Snapshot Writer — Phase 5 bulk-options closure
//
//  Polls `analyzeOptionChain()` for the F&O whitelist and persists
//  PCR, bias, IV state, and key support/resistance per symbol into
//  `q365_options_snapshots`. The bulk signal enricher reads the
//  latest snapshot per symbol so the /api/signals?action=all path
//  can surface real options bias per row without calling the
//  provider once per signal.
//
//  Safety:
//   - Honest: skips symbols where the provider returns null. Never
//     fabricates PCR / bias.
//   - Bounded: only walks the whitelist. Easy to extend later.
//   - Idempotent: each successful probe writes a new row, but the
//     bulk loader reads `MAX(snapshot_at)` per symbol so duplicates
//     don't double-count.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import { analyzeOptionChain } from '@/services/optionIntelligence';

export const OPTIONS_FNO_WHITELIST: readonly string[] = [
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX',
];

export interface OptionsSnapshotResult {
  probed:    number;
  written:   number;
  skipped:   number;
  errors:    number;
  elapsedMs: number;
  perSymbol: Array<{
    symbol:  string;
    ok:      boolean;
    bias:    string | null;
    pcr:     number | null;
    error?:  string;
  }>;
}

export async function backfillOptionsSnapshots(
  symbols: readonly string[] = OPTIONS_FNO_WHITELIST,
): Promise<OptionsSnapshotResult> {
  await ensureAllSchemas();
  const t0 = Date.now();
  let written = 0, skipped = 0, errors = 0;
  const perSymbol: OptionsSnapshotResult['perSymbol'] = [];

  for (const symbol of symbols) {
    try {
      const intel = await analyzeOptionChain(symbol).catch(() => null);
      if (!intel) {
        // Provider has no chain for this symbol right now — record as
        // skip and continue. We do NOT write a row, so the bulk
        // loader's MAX(snapshot_at) read still returns the previous
        // good snapshot (or nothing if there isn't one).
        skipped++;
        perSymbol.push({ symbol, ok: false, bias: null, pcr: null, error: 'provider_unavailable' });
        continue;
      }

      const pcr  = typeof intel.pcr === 'number' ? intel.pcr : null;
      const bias =
        pcr != null && pcr > 1.3 ? 'BULLISH'
        : pcr != null && pcr < 0.7 ? 'BEARISH'
        :                            'NEUTRAL';
      const ivCtx = String((intel as { ivContext?: string }).ivContext ?? '').toLowerCase();
      const ivState = ivCtx.includes('extreme')  ? 'EXTREME'
                    : ivCtx.includes('elevated') ? 'ELEVATED'
                    : ivCtx.includes('low')      ? 'LOW'
                    :                              'NORMAL';
      const keySupport    = intel.strongSupport?.[0]?.strike    ?? null;
      const keyResistance = intel.strongResistance?.[0]?.strike ?? null;

      await db.query(
        `INSERT INTO q365_options_snapshots
          (symbol, pcr, bias, iv_state, key_support, key_resistance, source, snapshot_at)
         VALUES (?, ?, ?, ?, ?, ?, 'live', NOW())
         ON DUPLICATE KEY UPDATE
           pcr=VALUES(pcr), bias=VALUES(bias), iv_state=VALUES(iv_state),
           key_support=VALUES(key_support), key_resistance=VALUES(key_resistance),
           source=VALUES(source)`,
        [symbol, pcr, bias, ivState, keySupport, keyResistance],
      );
      written++;
      perSymbol.push({ symbol, ok: true, bias, pcr });
    } catch (e) {
      errors++;
      perSymbol.push({ symbol, ok: false, bias: null, pcr: null, error: (e as Error).message });
    }
  }

  return {
    probed:    symbols.length,
    written, skipped, errors,
    elapsedMs: Date.now() - t0,
    perSymbol,
  };
}

// ── Read-side helper consumed by the bulk enricher. ──

export interface PersistedOptionsSnapshot {
  symbol:         string;
  pcr:            number | null;
  bias:           'BULLISH' | 'BEARISH' | 'NEUTRAL' | null;
  ivState:        'LOW' | 'NORMAL' | 'ELEVATED' | 'EXTREME' | null;
  keySupport:     number | null;
  keyResistance:  number | null;
  source:         'live' | 'estimated' | 'unavailable';
  snapshotAt:     string;
  /** Minutes since the snapshot was written. Older than 8h → loader
   *  treats as stale and falls back to UNAVAILABLE. */
  ageMinutes:     number;
}

const MAX_FRESH_MIN = 8 * 60;

export async function loadOptionsSnapshotsByBatch(
  symbols: readonly string[],
): Promise<Map<string, PersistedOptionsSnapshot>> {
  const out = new Map<string, PersistedOptionsSnapshot>();
  if (symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols.filter((s): s is string => typeof s === 'string' && !!s))).slice(0, 500);
  if (uniq.length === 0) return out;

  try {
    const placeholders = uniq.map(() => '?').join(',');
    // Latest row per symbol via JOIN-on-max.
    const { rows } = await db.query<any>(
      `SELECT o.symbol, o.pcr, o.bias, o.iv_state, o.key_support, o.key_resistance,
              o.source, o.snapshot_at
         FROM q365_options_snapshots o
         JOIN (
                SELECT symbol, MAX(snapshot_at) AS d
                  FROM q365_options_snapshots
                 WHERE symbol IN (${placeholders})
                 GROUP BY symbol
              ) latest
           ON latest.symbol = o.symbol AND latest.d = o.snapshot_at`,
      uniq,
    );

    const now = Date.now();
    for (const r of rows ?? []) {
      const snapAt = r.snapshot_at instanceof Date
        ? r.snapshot_at.toISOString()
        : typeof r.snapshot_at === 'string'
          ? new Date(r.snapshot_at).toISOString()
          : new Date().toISOString();
      const ageMs = now - new Date(snapAt).getTime();
      const ageMinutes = Math.max(0, Math.round(ageMs / 60_000));
      if (ageMinutes > MAX_FRESH_MIN) continue;  // stale — bulk loader ignores

      out.set(String(r.symbol), {
        symbol:        String(r.symbol),
        pcr:           r.pcr != null ? Number(r.pcr) : null,
        bias:          (r.bias as PersistedOptionsSnapshot['bias']) ?? null,
        ivState:       (r.iv_state as PersistedOptionsSnapshot['ivState']) ?? null,
        keySupport:    r.key_support != null ? Number(r.key_support) : null,
        keyResistance: r.key_resistance != null ? Number(r.key_resistance) : null,
        source:        (r.source as PersistedOptionsSnapshot['source']) ?? 'live',
        snapshotAt:    snapAt,
        ageMinutes,
      });
    }
  } catch {
    // Table missing on this DB — empty map is the correct soft-fail.
  }
  return out;
}
