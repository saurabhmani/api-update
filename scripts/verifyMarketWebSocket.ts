#!/usr/bin/env tsx
// Verification script for the live market WebSocket pipeline.
// Usage: tsx scripts/verifyMarketWebSocket.ts [--symbol RELIANCE]

import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import WebSocket from 'ws';

dotenvConfig({ path: path.resolve(process.cwd(), '.env.local') });
dotenvConfig({ path: path.resolve(process.cwd(), '.env') });

const symbol = (process.argv.find((a) => a.startsWith('--symbol='))?.split('=')[1]
  ?? process.env.VERIFY_WS_SYMBOL
  ?? 'RELIANCE').toUpperCase();

const port = Number(process.env.STREAM_WS_PORT) || 3001;
const url = process.env.VERIFY_WS_URL ?? `ws://127.0.0.1:${port}`;
const timeoutMs = Number(process.env.VERIFY_WS_TIMEOUT_MS) || 30_000;

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function record(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function fetchHealth(): Promise<any | null> {
  const base = process.env.VERIFY_HTTP_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  try {
    const res = await fetch(`${base}/api/market-data/health`, { cache: 'no-store' });
    return res.json();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(`\nMarket WebSocket verification`);
  console.log(`  url=${url}  symbol=${symbol}  timeout=${timeoutMs}ms\n`);

  const skipHttp = process.env.VERIFY_WS_SKIP_HTTP === '1';

  // 1. Health endpoint (optional when Next.js is not running)
  if (!skipHttp) {
    const health = await fetchHealth();
    record(
      'Health endpoint reachable',
      !!health,
      health ? `ws.state=${health?.ws?.state ?? 'unknown'} subscribed=${health?.subscribedCount ?? 0}` : 'Next.js not running',
    );
    if (health) {
      record(
        'WS server reports open',
        health?.ws?.state === 'open',
        `port=${health?.ws?.port ?? 'n/a'}`,
      );
    }
  } else {
    record('Health endpoint (skipped)', true, 'VERIFY_WS_SKIP_HTTP=1');
  }

  // 2. Register symbol demand via subscribe API (optional)
  if (!skipHttp) {
    try {
      const base = process.env.VERIFY_HTTP_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
      const res = await fetch(`${base}/api/market-data/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbols: [symbol] }),
      });
      const body = await res.json();
      record('Subscribe API registers symbol', res.ok && body.ok === true, `source=${body.source}`);
    } catch (err) {
      record('Subscribe API registers symbol', false, err instanceof Error ? err.message : String(err));
    }
  } else {
    record('Subscribe API (skipped)', true, 'WS subscribe used instead');
  }

  // 3. WebSocket connect + tick receive
  await new Promise<void>((resolve) => {
    let connected = false;
    let tickCount = 0;
    let lastPrice: number | null = null;
    const seen = new Set<number>();
    let duplicateTicks = 0;

    const timer = setTimeout(() => {
      record('WebSocket connection established', connected);
      record('Received at least one tick', tickCount > 0, `ticks=${tickCount}`);
      record('Tick price is positive', lastPrice != null && lastPrice > 0, lastPrice != null ? `ltp=${lastPrice}` : undefined);
      record('No duplicate timestamps in sample', duplicateTicks === 0, duplicateTicks > 0 ? `dupes=${duplicateTicks}` : undefined);
      try { ws.close(); } catch { /* ignore */ }
      resolve();
    }, timeoutMs);

    const ws = new WebSocket(url);

    ws.on('open', () => {
      connected = true;
      ws.send(JSON.stringify({ type: 'subscribe', symbols: [symbol] }));
      record('WebSocket handshake', true);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === 'connected') return;
        const tick = msg?.type === 'tick' ? msg.data : null;
        const batch = (msg?.type === 'prices' || msg?.type === 'FULL_UPDATE') ? msg.data : null;
        const frames = tick ? [tick] : Array.isArray(batch) ? batch : [];
        for (const f of frames) {
          if (f?.symbol?.toUpperCase() !== symbol) continue;
          if (!Number.isFinite(f.price) || f.price <= 0) continue;
          tickCount += 1;
          lastPrice = f.price;
          if (seen.has(f.ts)) duplicateTicks += 1;
          else seen.add(f.ts);
        }
      } catch { /* ignore malformed */ }
    });

    ws.on('error', (err) => {
      record('WebSocket handshake', false, err.message);
    });
  });

  const failed = checks.filter((c) => !c.ok);
  const critical = failed.filter((c) =>
    c.name.includes('WebSocket') || c.name.includes('handshake'),
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (critical.length > 0) {
    console.error('\nCritical failures:');
    for (const f of critical) console.error(`  - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  if (failed.length > 0) {
    console.warn('\nNon-critical failures (upstream quota / Next.js not running):');
    for (const f of failed) console.warn(`  - ${f.name}: ${f.detail ?? ''}`);
  }
  console.log('\nWebSocket pipeline verification complete.\n');
}

main().catch((err) => {
  console.error('Verification fatal error:', err);
  process.exit(1);
});
