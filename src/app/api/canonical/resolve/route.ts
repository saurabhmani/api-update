// GET /api/canonical/resolve?ticker=RELIANCE — Resolve ticker to canonical instrumentId
// GET /api/canonical/resolve?id=42 — Resolve instrumentId to full ref
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError, NotFoundError } from '@/lib/errors';
import { resolve, resolveBatch } from '@/services/instrumentResolver';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const ticker = sp.get('ticker');
  const id = sp.get('id');
  const batch = sp.get('batch'); // comma-separated tickers

  if (batch) {
    const tickers = batch.split(',').map(t => t.trim()).filter(Boolean);
    if (!tickers.length) throw new ValidationError('batch must be comma-separated tickers');
    const map = await resolveBatch(tickers);
    const results: Record<string, any> = {};
    for (const [k, v] of map) results[k] = v;
    return { data: results, resolved: map.size, requested: tickers.length };
  }

  if (!ticker && !id) throw new ValidationError('ticker, id, or batch is required');

  const ref = await resolve(id ? Number(id) : ticker!);
  if (!ref) throw new NotFoundError('Instrument', ticker ?? id ?? '');

  return { data: ref };
});
