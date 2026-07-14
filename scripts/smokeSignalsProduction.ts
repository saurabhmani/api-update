/**
 * smokeSignalsProduction.ts — one-command signals production smoke.
 *
 * Runs the four critical paths from the production readiness plan and
 * prints a single PASS/FAIL report with a debug hint per failure:
 *
 *   A — Cold start → visible signals (health, freshness, counters)
 *   B — Market-hours live feed (live-feed-status, dual-source,
 *       data-feed health, engine-health data feed node)
 *   C — Custom-universe scanner (status endpoint reachable + sane)
 *   D — Displayable count parity (signals API counters == shared
 *       filter over approvedSignals == dashboard signalSummary)
 *
 * Read-only by default — safe to run against production. Pass
 * `--scan` to also trigger a synchronous pipeline run (Path A step 3).
 *
 * Usage:
 *   npm run smoke:signals
 *   UI_BASE_URL=https://prod.example.com ENGINE_AUTH_COOKIE='q200_session=…' npm run smoke:signals
 *   npm run smoke:signals -- --scan       # also trigger mode=scan
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { filterDisplayableApproved } from '@/lib/signals/filterDisplayableApproved';

const BASE_URL =
  process.env.UI_BASE_URL?.trim()
  || process.env.INTERNAL_APP_URL?.trim()
  || 'http://127.0.0.1:3000';

const TRIGGER_SCAN = process.argv.includes('--scan');

interface CheckResult {
  path:  'A' | 'B' | 'C' | 'D';
  name:  string;
  pass:  boolean;
  detail: string;
  debugHint?: string;
}

const results: CheckResult[] = [];

function record(r: CheckResult): void {
  results.push(r);
  const mark = r.pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${r.path}.${r.name} — ${r.detail}`);
  if (!r.pass && r.debugHint) console.log(`         debug: ${r.debugHint}`);
}

async function resolveAuthCookie(): Promise<string | null> {
  if (process.env.ENGINE_AUTH_COOKIE) return process.env.ENGINE_AUTH_COOKIE;
  if (process.env.Q365_SESSION_COOKIE) return process.env.Q365_SESSION_COOKIE;
  try {
    const { rows } = await db.query<{ token: string }>(
      `SELECT token FROM user_sessions WHERE expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`,
    );
    return rows[0]?.token ? `q200_session=${rows[0].token}` : null;
  } catch {
    return null;
  }
}

async function fetchJson(
  path: string,
  cookie: string | null,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(init.method === 'POST' ? 600_000 : 30_000),
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: (e as Error).message };
  }
}

// ── Path A — cold start → visible signals ────────────────────────
async function pathA(cookie: string | null): Promise<void> {
  console.log('\nPath A — cold start → visible signals');

  const health = await fetchJson('/api/health', null);
  record({
    path: 'A', name: 'health',
    pass: health.ok && health.data?.status !== 'broken',
    detail: `GET /api/health → ${health.status} status=${health.data?.status ?? 'n/a'}`,
    debugHint: 'check DB/Redis connectivity and boot logs',
  });

  const freshness = await fetchJson('/api/signals/freshness', cookie);
  const confirmed = Number(
    freshness.data?.freshness?.active_confirmed_count
    ?? freshness.data?.active_confirmed_count
    ?? NaN,
  );
  record({
    path: 'A', name: 'freshness',
    pass: freshness.ok,
    detail: `GET /api/signals/freshness → ${freshness.status} active_confirmed_count=${Number.isFinite(confirmed) ? confirmed : 'n/a'}`,
    debugHint: 'npx tsx scripts/diagnoseSignalFunnel.ts',
  });

  if (TRIGGER_SCAN) {
    if (!cookie) {
      record({
        path: 'A', name: 'scan',
        pass: false,
        detail: '--scan requested but no auth cookie available',
        debugHint: 'set ENGINE_AUTH_COOKIE or ensure a live user_sessions row',
      });
    } else {
      const before = String(freshness.data?.freshness?.latest_batch_id ?? '');
      const scan = await fetchJson('/api/run-signal-engine?mode=scan&sync=true', cookie, { method: 'POST' });
      const after = await fetchJson('/api/signals/freshness', cookie);
      const newBatch = String(after.data?.freshness?.latest_batch_id ?? '');
      record({
        path: 'A', name: 'scan',
        pass: scan.ok && (newBatch !== '' && newBatch !== before),
        detail: `POST run-signal-engine → ${scan.status}; batch ${before || '<none>'} → ${newBatch || '<none>'}`,
        debugHint: 'GET /api/run-signal-engine?status=true; scripts/unblockExecutionLock.ts if stuck',
      });
    }
  }

  const signals = await fetchJson('/api/signals?action=all&limit=50', cookie);
  const approvedTotal = Number(signals.data?.counters?.approvedTotal ?? NaN);
  record({
    path: 'A', name: 'signalsApi',
    pass: signals.ok && Number.isFinite(approvedTotal),
    detail: `GET /api/signals → ${signals.status} counters.approvedTotal=${Number.isFinite(approvedTotal) ? approvedTotal : 'n/a'}`,
    debugHint: 'GET /api/signals/diagnostics; npx tsx scripts/diagnoseSignalFunnel.ts',
  });
}

// ── Path B — market-hours live feed ──────────────────────────────
async function pathB(cookie: string | null): Promise<void> {
  console.log('\nPath B — live feed (market-hours checks soften when closed)');

  const feed = await fetchJson('/api/market-data/live-feed-status', null);
  const marketOpen = feed.data?.marketOpen === true;
  const quality = String(feed.data?.quality ?? 'n/a');
  const feedHealthyOrClosed = !marketOpen || quality === 'fresh' || quality === 'delayed' || quality === 'closed_market';
  record({
    path: 'B', name: 'liveFeed',
    pass: feed.ok && feedHealthyOrClosed,
    detail: `quality=${quality} marketOpen=${marketOpen}`,
    debugHint: 'npx tsx scripts/probeLiveWs.ts; check STREAM_WS_DISABLED and removed vendor breaker',
  });

  const dual = await fetchJson('/api/market-data/dual-source/status', null);
  const dualEnabled = dual.data?.enabled === true;
  record({
    path: 'B', name: 'dualSource',
    pass: dual.ok,
    detail: `GET dual-source/status → ${dual.status} enabled=${dualEnabled}`,
    debugHint: 'check DUAL_SOURCE_ENABLED and provider legs in the response body',
  });

  const dfHealth = await fetchJson('/api/data-feed/health', cookie);
  const dfFreshness = String(dfHealth.data?.freshness ?? 'n/a');
  record({
    path: 'B', name: 'dataFeedHealth',
    pass: dfHealth.ok && (!marketOpen || dfFreshness === 'Fresh'),
    detail: `freshness=${dfFreshness} (market ${marketOpen ? 'open' : 'closed'})`,
    debugHint: 'ring buffer in GET /api/data-feed/health?history=50',
  });

  const engineHealth = await fetchJson('/api/signals/engine-health', cookie);
  const nodes: Array<{ name?: string; label?: string; status?: string }> =
    engineHealth.data?.health?.nodes ?? engineHealth.data?.nodes ?? [];
  const dataFeedNode = nodes.find((n) =>
    /data.?feed/i.test(String(n.name ?? n.label ?? '')));
  const nodeStatus = String(dataFeedNode?.status ?? 'n/a');
  record({
    path: 'B', name: 'engineHealthFeedNode',
    pass: engineHealth.ok && (!marketOpen || !dataFeedNode || nodeStatus === 'HEALTHY'),
    detail: `data feed node=${nodeStatus} overall=${engineHealth.data?.health?.overallStatus ?? 'n/a'}`,
    debugHint: 'live_feed_quality wiring in src/lib/signals/engineHealthMap.ts',
  });
}

// ── Path C — custom-universe scanner status ──────────────────────
async function pathC(cookie: string | null): Promise<void> {
  console.log('\nPath C — custom-universe scanner');

  const status = await fetchJson('/api/scanner/custom-universe/status', cookie);
  const hasShape = status.data != null
    && 'inFlight' in status.data
    && 'lastSummary' in status.data;
  record({
    path: 'C', name: 'statusEndpoint',
    pass: status.ok && hasShape,
    detail: `GET scanner/custom-universe/status → ${status.status} inFlight=${status.data?.inFlight ?? 'n/a'} lastBatch=${status.data?.lastSummary?.batchId ?? '<none>'}`,
    debugHint: status.status === 401
      ? 'auth required — set ENGINE_AUTH_COOKIE'
      : 'route src/app/api/scanner/custom-universe/status/route.ts; scannerState watchdog',
  });
}

// ── Path D — displayable count parity ────────────────────────────
async function pathD(cookie: string | null): Promise<void> {
  console.log('\nPath D — displayable count parity');

  const signals = await fetchJson('/api/signals?action=all&limit=100', cookie);
  const approvedRows: Array<Record<string, unknown>> =
    signals.data?.approvedSignals ?? signals.data?.signals ?? [];
  const signalQuality = String(signals.data?.signal_quality ?? '') || null;
  const apiApprovedTotal = Number(signals.data?.counters?.approvedTotal ?? NaN);
  const localDisplayable = filterDisplayableApproved(approvedRows, signalQuality).length;

  record({
    path: 'D', name: 'signalsCounterParity',
    pass: signals.ok && apiApprovedTotal === localDisplayable,
    detail: `counters.approvedTotal=${apiApprovedTotal} vs local filterDisplayableApproved=${localDisplayable} (raw approved=${approvedRows.length}, quality=${signalQuality ?? 'n/a'})`,
    debugHint: 'grep [DASHBOARD_AGG] in server logs; src/lib/signals/filterDisplayableApproved.ts',
  });

  const dashboard = await fetchJson('/api/dashboard', cookie);
  const dashApproved = Number(dashboard.data?.signalSummary?.approvedTotal ?? NaN);
  record({
    path: 'D', name: 'dashboardParity',
    pass: dashboard.ok && dashApproved === apiApprovedTotal,
    detail: `dashboard signalSummary.approvedTotal=${dashApproved} vs signals counters.approvedTotal=${apiApprovedTotal}`,
    debugHint: 'grep [DASHBOARD_SOURCE] in server logs (raw vs displayable inputs)',
  });
}

async function main(): Promise<void> {
  console.log(`Signals production smoke — ${BASE_URL}${TRIGGER_SCAN ? ' (with --scan)' : ' (read-only)'}`);

  const probe = await fetchJson('/api/health', null);
  if (probe.status === 0) {
    console.error(`\nServer unreachable at ${BASE_URL}: ${probe.error}`);
    console.error('Set UI_BASE_URL or start the app (npm run dev / pm2).');
    process.exit(2);
  }

  const cookie = await resolveAuthCookie();
  if (!cookie) {
    console.warn('No auth cookie resolved — authenticated checks may report 401.');
    console.warn('Set ENGINE_AUTH_COOKIE="q200_session=…" for full coverage.\n');
  }

  await pathA(cookie);
  await pathB(cookie);
  await pathC(cookie);
  await pathD(cookie);

  const failed = results.filter((r) => !r.pass);
  console.log('\n════════════════════════════════════════');
  console.log(`Result: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  • ${f.path}.${f.name} — ${f.detail}`);
    console.log('\nSee docs/signals-debug-playbook.md for decision trees.');
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke:signals crashed:', e);
  process.exit(2);
});
