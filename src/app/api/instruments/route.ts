import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';
import { cacheGet } from '@/lib/redis';
import { fetchQuote } from '@/services/marketQuote';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const key = req.nextUrl.searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  // Layer 1: instruments table (populated after admin sync)
  const { rows } = await db.query(
    `SELECT * FROM instruments WHERE instrument_key=? LIMIT 1`, [key]
  ).catch(() => ({ rows: [] }));

  if (rows.length) return NextResponse.json({ instrument: rows[0] });

  // Extract symbol from key e.g. "NSE_EQ|GALLANTT" → "GALLANTT"
  const sym    = key.includes('|') ? key.split('|')[1].toUpperCase() : key.toUpperCase();
  const exch   = key.includes('|') ? key.split('|')[0].replace('_EQ','').replace('_FO','') : 'NSE';

  // Layer 2: rankings table
  const { rows: rankRows } = await db.query(
    `SELECT instrument_key, exchange, tradingsymbol, name FROM rankings
     WHERE instrument_key=? OR tradingsymbol=? LIMIT 1`,
    [key, sym]
  ).catch(() => ({ rows: [] }));

  if (rankRows.length) {
    const r = rankRows[0] as any;
    return NextResponse.json({
      instrument: {
        instrument_key:  r.instrument_key || key,
        exchange:        r.exchange || exch,
        tradingsymbol:   r.tradingsymbol || sym,
        name:            r.name || sym,
        instrument_type: 'EQ',
      },
    });
  }

  // Layer 3: Live quote via Kite+Yahoo resolver
  try {
    const quote = await fetchQuote(sym);
    if (quote) {
      return NextResponse.json({
        instrument: {
          instrument_key:  key,
          exchange:        exch,
          tradingsymbol:   sym,
          name:            sym,
          instrument_type: 'EQ',
          ltp:             quote.lastPrice,
          pct_change:      quote.pChange,
        },
      });
    }
  } catch { /* resolver unavailable */ }

  return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
}
