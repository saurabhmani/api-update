// ════════════════════════════════════════════════════════════════
//  Trust Watchlist — user watchlist with intelligence categories
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { generateSignal } from '@/lib/signal-engine/live/analyzeInstrument';
import { cacheGet } from '@/lib/redis';
import type { MarketSnapshot } from '@/services/marketDataService';
import type { TrustWatchlistCategory, TrustWatchlistItem } from '../types';

type WatchlistCategory = TrustWatchlistCategory;

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

export async function loadTrustWatchlist(userId: number): Promise<TrustWatchlistItem[]> {
  const { rows: wlRows } = await db.query(
    'SELECT id FROM watchlists WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (!wlRows.length) return [];

  const watchlistId = (wlRows[0] as { id: number }).id;
  const { rows: items } = await db.query(
    `SELECT instrument_key, tradingsymbol, exchange, name
     FROM watchlist_items WHERE watchlist_id = ?`,
    [watchlistId],
  );

  const scored = await Promise.all(
    (items as Array<Record<string, string>>).map(async (item) => {
      const signal = await generateSignal(
        item.instrument_key,
        item.tradingsymbol,
        item.exchange,
      );

      let ltp: number | null = null;
      let changePct: number | null = null;
      try {
        const snap = await cacheGet<MarketSnapshot>(`stock:${item.tradingsymbol.toUpperCase()}`);
        if (snap?.ltp) {
          ltp = snap.ltp;
          changePct = snap.change_percent ?? null;
        }
      } catch { /* cache miss */ }

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

  return scored;
}
