// ════════════════════════════════════════════════════════════════
//  symbolMapper — single canonical NSE→IndianAPI symbol translation.
//
//  Lookup chain (in order):
//    1. Trim + uppercase + strip non-[A-Z0-9&._-].
//    2. q365_symbol_mapping_override.api_symbol if a row exists.
//    3. Static dictionary fallback (DELIBERATELY EMPTY at start —
//       we do not pre-guess M&M / BAJAJ-AUTO / L&TFH because the
//       upstream accepts the ampersand and hyphen forms on the
//       plans we use. Add entries here ONLY after a verified
//       symbol-not-found has been logged from the live API).
//    4. Default: return the cleaned input.
//
//  Caching: the override table is read once per process into an
//  in-memory Map. Reload via POST /api/admin/symbol-map/reload
//  (TODO — out of scope for this PR).
//
//  No upstream call site should call symbol.toUpperCase() in front
//  of the IndianAPI adapter any more. Every adapter method routes
//  its input through mapToIndianApiSymbol first.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'symbolMapper' });

// ── Static fallback dictionary ───────────────────────────────────
// INTENTIONALLY EMPTY. Add an entry here only after the upstream
// rejects a default-mapped symbol with a verifiable error. Every
// guess we add is a production landmine; an explicit DB override
// (q365_symbol_mapping_override) is preferred for ops fixes.
const STATIC_FALLBACK: Record<string, string> = {};

// ── In-process cache for the DB override table ───────────────────
let overrideCache: Map<string, string> | null = null;
let cachePromise: Promise<Map<string, string>> | null = null;

async function loadOverrideCache(): Promise<Map<string, string>> {
  if (overrideCache) return overrideCache;
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    const m = new Map<string, string>();
    try {
      const { rows } = await db.query<{ nse_symbol: string; api_symbol: string }>(
        `SELECT nse_symbol, api_symbol FROM q365_symbol_mapping_override`,
      );
      for (const r of rows as any[]) {
        m.set(String(r.nse_symbol).toUpperCase(), String(r.api_symbol));
      }
      log.info('symbolMapper override loaded', { count: m.size });
    } catch (err) {
      // Table missing on a fresh DB is fine; map stays empty.
      log.warn('symbolMapper override load failed (continuing with empty override)',
        { error: err instanceof Error ? err.message : String(err) });
    }
    overrideCache = m;
    cachePromise = null;
    return m;
  })();
  return cachePromise;
}

/** Force a reload of the override cache. Used by the future admin
 *  reload endpoint. */
export function _resetSymbolMapperCacheForTests(): void {
  overrideCache = null;
  cachePromise = null;
}

/** Step 1 of the chain — strip whitespace and noise characters. */
function clean(raw: string): string {
  let v = String(raw ?? '').trim();
  if (v.charCodeAt(0) === 0xFEFF) v = v.slice(1);          // BOM
  v = v.replace(/^["']|["']$/g, '').trim();
  v = v.toUpperCase();
  // Strip Yahoo suffix if it slipped through.
  v = v.replace(/\.(NS|BO|BSE)$/i, '');
  // Allowed character set: letters, digits, & . _ -
  v = v.replace(/[^A-Z0-9&._-]/g, '');
  return v;
}

/**
 * Map an NSE symbol to the form IndianAPI expects.
 *
 *   - Cleans the input first.
 *   - Honours an operator override row in q365_symbol_mapping_override.
 *   - Falls back to the static dictionary (deliberately empty by default).
 *   - Otherwise returns the cleaned input unchanged.
 */
export async function mapToIndianApiSymbol(nseSymbol: string): Promise<string> {
  const cleaned = clean(nseSymbol);
  if (!cleaned) return cleaned;

  const overrides = await loadOverrideCache();
  const fromOverride = overrides.get(cleaned);
  if (fromOverride) return fromOverride;

  const fromStatic = STATIC_FALLBACK[cleaned];
  if (fromStatic) return fromStatic;

  return cleaned;
}

/** Bulk variant — preserves input order. */
export async function mapManyToIndianApiSymbol(
  nseSymbols: string[],
): Promise<string[]> {
  const overrides = await loadOverrideCache();
  return nseSymbols.map((raw) => {
    const cleaned = clean(raw);
    if (!cleaned) return cleaned;
    return overrides.get(cleaned) ?? STATIC_FALLBACK[cleaned] ?? cleaned;
  });
}
