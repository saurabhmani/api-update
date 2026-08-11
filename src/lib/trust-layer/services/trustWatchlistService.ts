// ════════════════════════════════════════════════════════════════
//  Trust Watchlist — user watchlist with intelligence categories
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { generateSignal } from '@/lib/signal-engine/live/analyzeInstrument';
import { cacheGet } from '@/lib/redis';
import type { MarketSnapshot } from '@/services/marketDataService';
import type { TrustWatchlistCategory, TrustWatchlistItem } from '../types';

type WatchlistCategory = TrustWatchlistCategory;

const ENGINE_WATCHLIST_LIMIT = 40;

function categorize(sig: {
  conviction_band?: string | null;
  rejection_reasons?: string[];
  rejection_codes?: string[];
  direction?: string;
} | null, approved: boolean): WatchlistCategory {
  if (!sig) return 'no_data';
  if (approved && sig.conviction_band === 'high_conviction') return 'actionable';
  if (approved) return 'actionable';

  const codes = sig.rejection_codes ?? [];
  if (codes.includes('REGIME_MISMATCH') || codes.includes('STANCE_BLOCKED')) return 'regime_mismatch';
  if (codes.includes('LOW_CONFIDENCE')) return 'low_confidence';
  if (sig.conviction_band === 'watchlist') return 'emerging';
  return 'blocked';
}

function categorizeFromClassification(classification: string | null): WatchlistCategory {
  const c = String(classification ?? '').toUpperCase();
  if (c === 'HIGH_CONVICTION' || c === 'VALID_SIGNAL') return 'actionable';
  if (c === 'WATCHLIST_ONLY' || c === 'DEVELOPING_SETUP') return 'emerging';
  if (c === 'NO_TRADE') return 'blocked';
  return 'low_confidence';
}

async function enrichQuote(tradingsymbol: string): Promise<{ ltp: number | null; changePct: number | null }> {
  let ltp: number | null = null;
  let changePct: number | null = null;
  try {
    const snap = await cacheGet<MarketSnapshot>(`stock:${tradingsymbol.toUpperCase()}`);
    if (snap?.ltp) {
      ltp = snap.ltp;
      changePct = snap.change_percent ?? null;
    }
  } catch { /* cache miss */ }

  // Fallback: if the Redis quote cache is cold (common off-hours or right
  // after a container restart) pull last-known LTP / pct_change from the
  // rankings table so the watchlist doesn't render em-dashes everywhere.
  if (ltp == null) {
    try {
      const { rows: r } = await db.query(
        'SELECT ltp, pct_change FROM rankings WHERE symbol = ? LIMIT 1',
        [tradingsymbol.toUpperCase()],
      );
      const row = r[0] as { ltp?: number; pct_change?: number } | undefined;
      if (row?.ltp != null) ltp = Number(row.ltp) || null;
      if (row?.pct_change != null && changePct == null) {
        changePct = Number(row.pct_change);
      }
    } catch { /* rankings unavailable */ }
  }

  return { ltp, changePct };
}

async function scoreUserWatchlistItems(
  items: Array<Record<string, string>>,
): Promise<TrustWatchlistItem[]> {
  return Promise.all(
    items.map(async (item) => {
      const signal = await generateSignal(
        item.instrument_key,
        item.tradingsymbol,
        item.exchange,
      );
      const { ltp, changePct } = await enrichQuote(item.tradingsymbol);

      if (!signal) {
        return {
          instrumentKey: item.instrument_key,
          tradingsymbol: item.tradingsymbol,
          exchange: item.exchange,
          name: item.name ?? null,
          category: 'no_data' as const,
          ltp,
          changePct,
          direction: 'HOLD',
          confidence: null,
          opportunityScore: 0,
          rejectionReasons: ['Market data unavailable'],
          warnings: [],
        };
      }

      const approved = signal.rejection_reasons.length === 0 && signal.direction !== 'HOLD';
      const category = categorize(signal, approved);

      return {
        instrumentKey: item.instrument_key,
        tradingsymbol: item.tradingsymbol,
        exchange: item.exchange,
        name: item.name ?? null,
        category,
        ltp,
        changePct,
        direction: signal.direction,
        confidence: signal.confidence ?? null,
        opportunityScore: signal.opportunity_score ?? 0,
        rejectionReasons: signal.rejection_reasons ?? [],
        warnings: signal.soft_warnings ?? [],
      };
    }),
  );
}

/**
 * When the personal watchlist is empty, surface recent engine watchlist /
 * developing / valid signals so Trust → Watchlist still shows intelligence
 * instead of a permanent empty table.
 */
async function loadEngineWatchlistFallback(): Promise<TrustWatchlistItem[]> {
  const { rows } = await db.query(
    `SELECT s.symbol, s.direction, s.confidence_score, s.classification,
            s.signal_type, s.rejection_codes_json, s.generated_at,
            i.instrument_key, i.exchange, i.name
       FROM q365_signals s
       LEFT JOIN instruments i
         ON i.tradingsymbol = s.symbol
        AND (i.exchange = 'NSE' OR i.exchange IS NULL)
      WHERE s.classification IN ('WATCHLIST_ONLY', 'DEVELOPING_SETUP', 'VALID_SIGNAL', 'HIGH_CONVICTION')
        AND s.generated_at >= DATE_SUB(NOW(), INTERVAL 3 DAY)
      ORDER BY
        FIELD(s.classification, 'HIGH_CONVICTION', 'VALID_SIGNAL', 'WATCHLIST_ONLY', 'DEVELOPING_SETUP'),
        s.confidence_score DESC,
        s.generated_at DESC
      LIMIT ${ENGINE_WATCHLIST_LIMIT}`,
  );

  const seen = new Set<string>();
  const out: TrustWatchlistItem[] = [];

  for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
    const symbol = String(row.symbol ?? '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const rejectionCodes = (() => {
      const raw = row.rejection_codes_json;
      if (!raw) return [] as string[];
      try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })();

    const classification = row.classification != null ? String(row.classification) : null;
    const category = categorizeFromClassification(classification);
    const { ltp, changePct } = await enrichQuote(symbol);
    const instrumentKey = String(row.instrument_key ?? `NSE_EQ|${symbol}`);
    const exchange = String(row.exchange ?? 'NSE');

    out.push({
      instrumentKey,
      tradingsymbol: symbol,
      exchange,
      name: row.name != null ? String(row.name) : null,
      category,
      ltp,
      changePct,
      direction: String(row.direction ?? 'HOLD').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      confidence: row.confidence_score != null ? Number(row.confidence_score) : null,
      opportunityScore: row.confidence_score != null ? Number(row.confidence_score) : 0,
      rejectionReasons: rejectionCodes,
      warnings:
        classification === 'WATCHLIST_ONLY' || classification === 'DEVELOPING_SETUP'
          ? [`Engine ${String(classification).toLowerCase().replace(/_/g, ' ')}`]
          : [],
    });
  }

  return out;
}

export async function loadTrustWatchlist(userId: number): Promise<TrustWatchlistItem[]> {
  const { rows: wlRows } = await db.query(
    'SELECT id FROM watchlists WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (!wlRows.length) {
    return loadEngineWatchlistFallback();
  }

  const watchlistId = (wlRows[0] as { id: number }).id;
  const { rows: items } = await db.query(
    `SELECT instrument_key, tradingsymbol, exchange, name
     FROM watchlist_items WHERE watchlist_id = ?`,
    [watchlistId],
  );

  if (!(items as unknown[]).length) {
    return loadEngineWatchlistFallback();
  }

  return scoreUserWatchlistItems(items as Array<Record<string, string>>);
}
