/**
 * Warehouse movers — deliberate product-supported rankings read.
 * Used by user-facing /api/market/movers so we never stamp kite/yahoo
 * live cascade as the user's connected broker.
 */

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'moversWarehouse' });

export interface WarehouseMoverRow {
  symbol: string;
  price: number;
  changePercent: number;
}

export interface WarehouseMovers {
  gainers: WarehouseMoverRow[];
  losers: WarehouseMoverRow[];
  mostActive: WarehouseMoverRow[];
  fetched_at: string;
  data_quality: 'stored';
}

const EMPTY: Omit<WarehouseMovers, 'fetched_at' | 'data_quality'> = {
  gainers: [],
  losers: [],
  mostActive: [],
};

export async function getMoversFromWarehouse(limit = 50): Promise<WarehouseMovers> {
  const mapRow = (r: { symbol?: string; ltp?: unknown; pct_change?: unknown }): WarehouseMoverRow => ({
    symbol: String(r.symbol ?? '').toUpperCase(),
    price: Number(r.ltp) || 0,
    changePercent: Number(r.pct_change) || 0,
  });
  const valid = (b: WarehouseMoverRow) =>
    Boolean(b.symbol) && Number.isFinite(b.price) && b.price > 0;

  try {
    const [gainersRes, losersRes, activeRes] = await Promise.all([
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE pct_change IS NOT NULL AND pct_change > 0
          ORDER BY pct_change DESC
          LIMIT ?`,
        [limit],
      ),
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE pct_change IS NOT NULL AND pct_change < 0
          ORDER BY pct_change ASC
          LIMIT ?`,
        [limit],
      ),
      db.query<{ symbol: string; ltp: number; pct_change: number }>(
        `SELECT tradingsymbol AS symbol, ltp, pct_change
           FROM rankings
          WHERE volume IS NOT NULL AND volume > 0
          ORDER BY volume DESC
          LIMIT ?`,
        [limit],
      ),
    ]);
    return {
      gainers: gainersRes.rows.map(mapRow).filter(valid),
      losers: losersRes.rows.map(mapRow).filter(valid),
      mostActive: activeRes.rows.map(mapRow).filter(valid),
      fetched_at: new Date().toISOString(),
      data_quality: 'stored',
    };
  } catch (err) {
    log.warn('rankings movers query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...EMPTY,
      fetched_at: new Date().toISOString(),
      data_quality: 'stored',
    };
  }
}
