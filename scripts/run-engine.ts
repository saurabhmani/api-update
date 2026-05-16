/**
 * scripts/run-engine.ts
 *
 * Periodic pipeline trigger. Calls /api/run-signal-engine on a fixed
 * cadence so the dashboard stays warm without a human clicking "Run
 * Pipeline" every minute.
 *
 * Defaults:
 *   - Endpoint: http://localhost:3000/api/run-signal-engine?force=true&override=true
 *   - Mode: async (the route returns 202 immediately, runs in background)
 *   - Interval: 60 seconds
 *   - Stops on Ctrl+C with a summary
 *
 * Tunable via env:
 *   ENGINE_BASE_URL     (default http://localhost:3000)
 *   ENGINE_INTERVAL_SEC (default 60, range 10-3600)
 *   ENGINE_AUTH_COOKIE  (optional: pasted browser session cookie if the
 *                        route requires auth; without it /api/run-signal-engine
 *                        will 401)
 *   ENGINE_SYNC         (default false — sync mode awaits the full scan;
 *                        only useful if you trust the wall-clock budget)
 *
 * Usage:
 *   npx tsx scripts/run-engine.ts
 *   ENGINE_INTERVAL_SEC=120 npx tsx scripts/run-engine.ts
 *
 * Exit code: 0 on clean Ctrl+C, 1 on persistent connect errors.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

// Resolved at runtime by probing host candidates. Why: Next.js dev
// binds to ONE of `localhost`, `127.0.0.1` (IPv4), or `[::1]` (IPv6)
// depending on Node version, OS, and Next version. On Windows + Node
// 18+ both directions of mismatch happen — `localhost` works in the
// browser but `127.0.0.1` times out because Next bound to IPv6 only,
// or vice-versa. Probe each candidate, use the first responsive one.
let BASE_URL = process.env.ENGINE_BASE_URL ?? '';
const PORT = (() => {
  const raw = Number(process.env.ENGINE_PORT);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 65535) return Math.floor(raw);
  // Try to derive port from ENGINE_BASE_URL if set.
  if (BASE_URL) {
    try { return Number(new URL(BASE_URL).port) || 3000; } catch { /* ignore */ }
  }
  return 3000;
})();
const HOST_CANDIDATES = (() => {
  if (BASE_URL) return [BASE_URL];
  return [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://[::1]:${PORT}`,
  ];
})();

const SYNC     = process.env.ENGINE_SYNC === 'true';
const INTERVAL_SEC = (() => {
  const raw = Number(process.env.ENGINE_INTERVAL_SEC);
  if (Number.isFinite(raw) && raw >= 10 && raw <= 3600) return Math.floor(raw);
  return 60;
})();
const COOKIE = process.env.ENGINE_AUTH_COOKIE ?? '';
const PROBE_TIMEOUT_MS = 4_000;

let runs    = 0;
let success = 0;
let failed  = 0;
let stopped = false;

function fmtNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Probe one host candidate. Returns null when reachable, error string
 *  otherwise. Tries `/api/health` first; falls back to `/` if health
 *  isn't routable. */
async function probeOne(base: string): Promise<string | null> {
  for (const path of ['/api/health', '/']) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      // Any HTTP response counts as "reachable" — even 404 means the
      // server is alive on this host.
      if (res.status >= 100 && res.status < 600) return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('aborted') || msg.includes('timeout')) {
        // Try the next path on this same host before giving up.
        clearTimeout(timer);
        if (path === '/api/health') continue;
        return `timeout after ${PROBE_TIMEOUT_MS}ms`;
      }
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('ENOTFOUND')) {
        clearTimeout(timer);
        return 'connection refused / not bound';
      }
      clearTimeout(timer);
      return msg;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Probe all host candidates in order. Sets BASE_URL to the first
 *  responsive one; returns null on success, error summary on failure. */
async function probeReachable(): Promise<string | null> {
  const errors: string[] = [];
  for (const candidate of HOST_CANDIDATES) {
    const err = await probeOne(candidate);
    if (err === null) {
      BASE_URL = candidate;
      return null;
    }
    errors.push(`  - ${candidate}: ${err}`);
  }
  return errors.join('\n');
}

async function triggerOnce(): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${BASE_URL}/api/run-signal-engine?force=true&override=true${SYNC ? '&sync=true' : ''}`;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (COOKIE) headers['Cookie'] = COOKIE;
    const res = await fetch(url, { method: 'POST', headers });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 200) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      body: msg.includes('fetch failed') || msg.includes('ECONNREFUSED')
        ? `connection refused — is the dev server running? (npm run dev). Tried ${url}`
        : msg,
    };
  }
}

async function loop(): Promise<void> {
  const candidatesLabel = HOST_CANDIDATES.length === 1
    ? HOST_CANDIDATES[0]
    : `${HOST_CANDIDATES.length} candidates (${HOST_CANDIDATES.join(', ')})`;
  console.log(`[run-engine] starting — base=${candidatesLabel} interval=${INTERVAL_SEC}s sync=${SYNC}`);
  if (!COOKIE) {
    console.warn(
      '[run-engine] ENGINE_AUTH_COOKIE is not set; the route will 401 if it requires auth. ' +
      'Copy your browser session cookie from DevTools → Application → Cookies and export it.',
    );
  }

  // Spec "fetch failed" diagnosis — probe each host candidate BEFORE
  // entering the poll loop. Pinpoints (a) "server not running" vs (b)
  // "running but bound to a different host family" — instead of looping
  // every minute on a host that's never going to answer.
  const probeError = await probeReachable();
  if (probeError) {
    console.error(
      `[run-engine] ✗ no host responded:\n${probeError}\n` +
      `\n` +
      `Likely fixes:\n` +
      `  1. Start the dev server in another terminal:  npm run dev\n` +
      `  2. Confirm it logs "Local:    http://localhost:${PORT}" or similar\n` +
      `  3. If it's on a different port:  ENGINE_PORT=3001 npm run engine:run-loop\n` +
      `  4. If you opened the dashboard at http://localhost:${PORT}/ but\n` +
      `     none of these candidates worked, the server is probably\n` +
      `     bound to a non-loopback address — set ENGINE_BASE_URL to your\n` +
      `     LAN IP, e.g. ENGINE_BASE_URL=http://192.168.1.42:${PORT}\n` +
      `\n` +
      `Refusing to spam every ${INTERVAL_SEC}s — exit and re-run after fixing.\n`,
    );
    process.exit(1);
  }
  console.log(`[run-engine] ✓ server reachable at ${BASE_URL} — entering poll loop`);

  while (!stopped) {
    runs++;
    const t0 = Date.now();
    const r = await triggerOnce();
    const elapsed = Date.now() - t0;
    if (r.ok) {
      success++;
      console.log(`[run-engine] ${fmtNow()} run=${runs} status=${r.status} elapsed=${elapsed}ms ✓`);
    } else {
      failed++;
      console.warn(
        `[run-engine] ${fmtNow()} run=${runs} status=${r.status} elapsed=${elapsed}ms ✗ ` +
        `body="${r.body}"`,
      );
      // After 3 consecutive failures, stop spamming and exit.
      if (failed >= 3 && success === 0) {
        console.error(
          `[run-engine] aborting after 3 consecutive failures — fix the underlying issue ` +
          `(server down? auth cookie missing? wrong URL?) and restart.`,
        );
        break;
      }
    }
    if (stopped) break;
    await new Promise((res) => setTimeout(res, INTERVAL_SEC * 1000));
  }
  console.log(
    `[run-engine] stopped — runs=${runs} success=${success} failed=${failed}`,
  );
}

process.on('SIGINT', () => {
  console.log('\n[run-engine] SIGINT — finishing current iteration and stopping.');
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});

loop()
  .then(() => process.exit(failed > 0 && success === 0 ? 1 : 0))
  .catch((err) => {
    console.error('[run-engine] crashed:', err);
    process.exit(1);
  });
