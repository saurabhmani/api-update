// ════════════════════════════════════════════════════════════════
//  /api/kite/ticker — Kite WebSocket streaming control surface
//
//  Auth: requires a live app session (q200_session cookie). The
//  ticker singleton itself uses whichever Kite access_token is
//  currently valid in kite_tokens — typically the one the same
//  user minted via /api/kite/login.
//
//  GET /api/kite/ticker
//       → { status, subscribed: [...] }
//
//  GET /api/kite/ticker?symbol=TITAN
//       → { symbol, tick: { lastPrice, change, ohlc, ts } }
//
//  GET /api/kite/ticker?subscribe=TITAN,RELIANCE,INFY&mode=quote
//       → browser-friendly subscribe (avoids curl/JSON quoting pain
//         on Windows). Comma-separated symbols in the query string.
//
//  GET /api/kite/ticker?unsubscribe=TITAN,RELIANCE
//       → browser-friendly unsubscribe
//
//  POST /api/kite/ticker
//       body: { action: 'subscribe',   symbols: [...], mode?: ... }
//       body: { action: 'unsubscribe', symbols: [...] }
//       body: { action: 'disconnect' }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker, type TickMode } from '@/lib/marketData/kiteTicker';
import { bootTickerSafe } from '@/lib/marketData/bootTicker';
import { getRunnerStats } from '@/lib/signal-engine/live/tickStrategyRunner';
import { getExecutorStats } from '@/lib/execution/signalExecutor';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function parseSymbols(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseMode(raw: string | null): TickMode {
  return raw === 'ltp' || raw === 'full' ? raw : 'quote';
}

async function requireAuth() {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return user;
}

export async function GET(req: NextRequest) {
  const authOrUser = await requireAuth();
  if (authOrUser instanceof NextResponse) return authOrUser;

  // Lazy boot fallback — the instrumentation hook normally boots
  // the pipeline at server start, but a fresh Kite token minted
  // AFTER startup would leave boot deferred. First authenticated
  // ticker hit retries the boot idempotently.
  await bootTickerSafe();

  const ticker = getTicker();
  const sp = req.nextUrl.searchParams;

  // ── Browser-friendly GET subscribe ─────────────────────────
  const sub = parseSymbols(sp.get('subscribe'));
  if (sub.length) {
    const { resolved, unknown } = await ticker.subscribeSymbols(sub, parseMode(sp.get('mode')));
    return NextResponse.json({
      action: 'subscribe',
      resolved,
      unknown,
      status: ticker.getStatus(),
    });
  }

  const unsub = parseSymbols(sp.get('unsubscribe'));
  if (unsub.length) {
    await ticker.unsubscribeSymbols(unsub);
    return NextResponse.json({
      action: 'unsubscribe',
      status: ticker.getStatus(),
    });
  }

  // ── Single-symbol tick probe ───────────────────────────────
  const symbol = sp.get('symbol')?.trim();
  if (symbol) {
    const tick = await ticker.getTickBySymbol(symbol);
    if (!tick) {
      return NextResponse.json(
        { symbol: symbol.toUpperCase(), tick: null, status: ticker.getStatus() },
        { status: 404 },
      );
    }
    return NextResponse.json({ symbol: symbol.toUpperCase(), tick });
  }

  // ── Default: status + subscribed list + runner stats ───────
  const subscribed = await ticker.listSubscribedSymbols();
  return NextResponse.json({
    status: ticker.getStatus(),
    subscribed: subscribed.length > 50
      ? { count: subscribed.length, sample: subscribed.slice(0, 50) }
      : subscribed,
    runner: getRunnerStats(),
    executor: getExecutorStats(),
  });
}

export async function POST(req: NextRequest) {
  const authOrUser = await requireAuth();
  if (authOrUser instanceof NextResponse) return authOrUser;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const ticker = getTicker();
  const action = String(body?.action ?? '').toLowerCase();

  try {
    if (action === 'subscribe') {
      const symbols = Array.isArray(body.symbols) ? body.symbols.map(String) : [];
      if (!symbols.length) {
        return NextResponse.json({ error: 'symbols[] required' }, { status: 400 });
      }
      const mode: TickMode = body.mode === 'ltp' || body.mode === 'full' ? body.mode : 'quote';
      const { resolved, unknown } = await ticker.subscribeSymbols(symbols, mode);
      return NextResponse.json({
        action: 'subscribe',
        mode,
        resolved,
        unknown,
        status: ticker.getStatus(),
      });
    }

    if (action === 'unsubscribe') {
      const symbols = Array.isArray(body.symbols) ? body.symbols.map(String) : [];
      if (!symbols.length) {
        return NextResponse.json({ error: 'symbols[] required' }, { status: 400 });
      }
      await ticker.unsubscribeSymbols(symbols);
      return NextResponse.json({ action: 'unsubscribe', status: ticker.getStatus() });
    }

    if (action === 'disconnect') {
      ticker.disconnect();
      return NextResponse.json({ action: 'disconnect', status: ticker.getStatus() });
    }

    return NextResponse.json(
      { error: `unknown action: ${action}` },
      { status: 400 },
    );
  } catch (err: any) {
    console.error('[POST /api/kite/ticker] failed:', err?.message);
    return NextResponse.json(
      { error: err?.message ?? 'ticker action failed' },
      { status: 500 },
    );
  }
}
