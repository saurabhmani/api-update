// ════════════════════════════════════════════════════════════════
//  GET /api/kite/diagnose
//
//  One-shot health check for the entire real-time pipeline.
//  Hit this when "kite=0 miss=N" shows up in signal enrichment
//  and you need to know which of the four possible root causes
//  is actually happening:
//
//    1. WebSocket not connected       → state !== 'open'
//    2. Access token missing/expired  → kiteStatus !== 'ok'
//    3. Zero subscriptions            → subscribed = 0
//    4. Signal universe not subscribed → signalSymbolsSubscribed = 0
//
//  Everything is read-only. No mutation. No REST calls except a
//  quick DB read for the top signal symbols.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getTicker, tryGetLiveTick } from '@/lib/marketData/kiteTicker';
import { getKiteStatus } from '@/lib/marketData/kiteSession';
import { db } from '@/lib/db';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ticker = getTicker();
  const status = ticker.getStatus();
  const kiteAuth = await getKiteStatus();

  // Pull the top 20 signal symbols straight from the DB so we can
  // cross-reference them against the ticker's subscribed set.
  let signalSymbols: string[] = [];
  try {
    // GROUP BY + MAX(generated_at) dedups by tradingsymbol while
    // preserving an ORDER BY target that MySQL accepts under
    // ONLY_FULL_GROUP_BY — the raw DISTINCT + ORDER BY form throws
    // "Expression #1 of ORDER BY clause is not in SELECT list".
    const { rows } = await db.query<{ tradingsymbol: string }>(
      `SELECT tradingsymbol, MAX(generated_at) AS latest_at
       FROM q365_signals
       WHERE status IN ('active','watchlist','flagged')
       GROUP BY tradingsymbol
       ORDER BY latest_at DESC
       LIMIT 20`,
    );
    signalSymbols = (rows as any[]).map((r) => String(r.tradingsymbol).toUpperCase());
  } catch (err: any) {
    console.warn('[diagnose] signal symbol query failed:', err?.message);
  }

  // For each signal symbol, check cache + freshness
  const now = Date.now();
  const signalChecks = signalSymbols.map((sym) => {
    const strict = tryGetLiveTick(sym);
    const cached = ticker.getTickBySymbolSync(sym);
    return {
      symbol:    sym,
      subscribed: cached != null,
      hasTick:   cached != null,
      fresh:     strict != null,
      ageMs:     cached ? now - cached.ts : null,
      lastPrice: cached?.lastPrice ?? null,
    };
  });

  const signalSubscribed = signalChecks.filter((c) => c.subscribed).length;
  const signalFresh      = signalChecks.filter((c) => c.fresh).length;

  // ── Root-cause inference ─────────────────────────────────
  const diagnosis: string[] = [];
  if (kiteAuth !== 'ok') {
    diagnosis.push(`AUTH: Kite token status is '${kiteAuth}' — visit /api/kite/login`);
  }
  if (status.state !== 'open') {
    diagnosis.push(`WS: socket state is '${status.state}' — not receiving frames`);
  }
  if (status.subscribed === 0) {
    diagnosis.push('SUBSCRIBE: no tokens subscribed — bootTicker may have failed');
  }
  if (status.ticksCached === 0 && status.subscribed > 0) {
    diagnosis.push(
      `INGRESS: subscribed=${status.subscribed} but ticksCached=0 — ` +
      `WS is open but no frames arrived; check market hours or broker-side issue`,
    );
  }
  if (signalSymbols.length > 0 && signalSubscribed === 0) {
    diagnosis.push(
      `UNIVERSE MISMATCH: ${signalSymbols.length} signal symbols exist but NONE are ` +
      `subscribed on the ticker. The boot universe (first 2000 by token order) does ` +
      `not overlap with the signal universe. Lazy-subscribe fires on first /api/signals ` +
      `call — confirm with a second request a few seconds later.`,
    );
  }
  if (signalSymbols.length > 0 && signalSubscribed > 0 && signalFresh === 0) {
    diagnosis.push(
      `STALE: ${signalSubscribed}/${signalSymbols.length} signal symbols are subscribed ` +
      `but none have fresh ticks (<2s). Market may be closed or feed is stalled.`,
    );
  }
  if (diagnosis.length === 0) {
    diagnosis.push('OK: pipeline healthy');
  }

  return NextResponse.json(
    {
      ok:        diagnosis[0].startsWith('OK'),
      diagnosis,
      kiteAuth,
      ticker: {
        state:             status.state,
        subscribed:        status.subscribed,
        ticksCached:       status.ticksCached,
        packetsReceived:   status.packetsReceived,
        lastConnectedAt:   status.lastConnectedAt,
        reconnectAttempts: status.reconnectAttempts,
        lastError:         status.lastError,
        mode:              status.mode,
      },
      signalUniverse: {
        count:       signalSymbols.length,
        subscribed:  signalSubscribed,
        fresh:       signalFresh,
        symbols:     signalChecks,
      },
    },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
