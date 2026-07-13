// ════════════════════════════════════════════════════════════════
//  Instrument metadata enrichment for sector analytics (Phase 5)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

export interface InstrumentMeta {
  symbol: string;
  sector: string;
  industry: string | null;
  exchange: string;
  marketCapBucket: string;
}

function marketCapBucket(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return 'Unknown';
  const cr = value / 1e7; // INR crores if stored in rupees; tolerate USD-like scale
  if (cr >= 100_000 || value >= 20_000_000_000) return 'Large Cap';
  if (cr >= 10_000 || value >= 5_000_000_000) return 'Mid Cap';
  if (cr >= 1_000 || value >= 500_000_000) return 'Small Cap';
  return 'Micro Cap';
}

export async function loadInstrumentMeta(symbols: string[]): Promise<Map<string, InstrumentMeta>> {
  const unique = Array.from(new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean)));
  const result = new Map<string, InstrumentMeta>();
  if (unique.length === 0) return result;

  const placeholders = unique.map(() => '?').join(',');
  try {
    const { rows } = await db.query<{
      tradingsymbol: string;
      sector: string | null;
      industry: string | null;
      exchange: string | null;
      market_cap: number | null;
    }>(
      `SELECT tradingsymbol, sector, industry, exchange, market_cap
         FROM instruments
        WHERE tradingsymbol IN (${placeholders}) AND is_active = 1`,
      unique,
    );
    for (const row of rows ?? []) {
      const sym = String(row.tradingsymbol).toUpperCase();
      result.set(sym, {
        symbol: sym,
        sector: row.sector?.trim() || getSector(sym),
        industry: row.industry?.trim() || null,
        exchange: row.exchange?.trim() || 'NSE',
        marketCapBucket: marketCapBucket(row.market_cap != null ? Number(row.market_cap) : null),
      });
    }
  } catch {
    // instruments table may be absent on some deployments
  }

  for (const sym of unique) {
    if (!result.has(sym)) {
      result.set(sym, {
        symbol: sym,
        sector: getSector(sym),
        industry: null,
        exchange: 'NSE',
        marketCapBucket: 'Unknown',
      });
    }
  }
  return result;
}
