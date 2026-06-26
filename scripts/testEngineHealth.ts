/**
 * testEngineHealth.ts — live HTTP acceptance for Engine Health + dashboard fusion.
 *
 * Exercises the same endpoints the Command Center uses:
 *   GET /api/signals/engine-health   → full health map (12 pipeline nodes)
 *   GET /api/dashboard               → intelligenceFusion.engineHealth parity
 *
 * Usage:
 *   npx tsx scripts/testEngineHealth.ts
 *   npx tsx scripts/testEngineHealth.ts --offline    # warehouse probes only (no server)
 *
 * Env:
 *   ENGINE_BASE_URL / UI_BASE_URL  — default tries 127.0.0.1:5000 then localhost:3000
 *   ENGINE_AUTH_COOKIE             — q200_session=… (explicit override; skips login)
 *   UI_EMAIL / UI_PASSWORD         — always used for remote hosts; preferred over local DB session
 *
 * Exit 0 = HEALTHY or WARNING overall · Exit 1 = DEGRADED/BROKEN/transport failure
 */

import { loadProjectEnv } from './loadProjectEnv';
loadProjectEnv();

import { db } from '@/lib/db';

type Band = 'OK' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  band: Band;
  detail: string;
}

const OFFLINE = process.argv.includes('--offline');
const checks: Check[] = [];

function record(name: string, band: Band, detail: string): void {
  checks.push({ name, band, detail });
}

function icon(b: Band): string {
  return b === 'OK' ? '✓' : b === 'WARN' ? '⚠' : '✗';
}

function mapDashboardFusionStatus(overall: string | undefined): string {
  if (overall === 'HEALTHY')  return 'HEALTHY';
  if (overall === 'WARNING')  return 'WARNING';
  if (overall === 'DEGRADED') return 'DEGRADED';
  if (overall === 'BROKEN')   return 'BROKEN';
  return 'UNKNOWN';
}

function isLoopbackBase(base: string): boolean {
  try {
    const { hostname } = new URL(base);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function hasLoginCredentials(): boolean {
  return Boolean(
    process.env.UI_PASSWORD?.trim()
    || process.env.SEED_ADMIN_PASSWORD?.trim(),
  );
}

async function readDbSessionCookie(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ token: string }>(
      `SELECT token FROM user_sessions WHERE expires_at > NOW() ORDER BY expires_at DESC LIMIT 1`,
    );
    const token = rows[0]?.token;
    return token ? `q200_session=${token}` : null;
  } catch {
    return null;
  }
}

async function validateCookie(base: string, cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/auth`, {
      headers: { Cookie: cookie, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Resolve a session valid for `base`. Never reuses a local DB token against a remote host. */
async function resolveSessionCookie(base: string): Promise<{ cookie: string; via: string }> {
  const explicit = process.env.ENGINE_AUTH_COOKIE?.trim();
  if (explicit) {
    return { cookie: explicit, via: 'ENGINE_AUTH_COOKIE' };
  }

  const remote = !isLoopbackBase(base);
  if (remote || hasLoginCredentials()) {
    const cookie = await login(base);
    return { cookie, via: remote ? 'login (remote host)' : 'login (UI_PASSWORD set)' };
  }

  const dbCookie = await readDbSessionCookie();
  if (dbCookie && await validateCookie(base, dbCookie)) {
    return { cookie: dbCookie, via: 'local DB session' };
  }

  if (hasLoginCredentials()) {
    const cookie = await login(base);
    return { cookie, via: 'login (DB session invalid)' };
  }

  throw new Error(
    'No valid session. Set UI_PASSWORD for remote hosts, or ENGINE_AUTH_COOKIE=q200_session=…',
  );
}

async function login(base: string): Promise<string> {
  const email = process.env.UI_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@quantorus365.in';
  const password = process.env.UI_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('No session cookie and UI_PASSWORD / SEED_ADMIN_PASSWORD not set');
  }
  const res = await fetch(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action: 'login', email, password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Login HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  for (const chunk of setCookie) {
    const m = /q200_session=[^;]+/.exec(chunk ?? '');
    if (m) return m[0];
  }
  throw new Error('Login succeeded but q200_session cookie missing');
}

async function probeServer(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(4_000) });
    return res.status >= 100 && res.status < 600;
  } catch {
    return false;
  }
}

async function resolveBase(): Promise<string | null> {
  const candidates = [
    process.env.ENGINE_BASE_URL,
    process.env.UI_BASE_URL,
    process.env.INTERNAL_APP_URL,
    'http://127.0.0.1:5000',
    'http://localhost:5000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ].filter((b): b is string => Boolean(b?.trim())).map((b) => b.replace(/\/$/, ''));

  const seen = new Set<string>();
  for (const base of candidates) {
    if (seen.has(base)) continue;
    seen.add(base);
    if (await probeServer(base)) return base;
  }
  return null;
}

async function fetchJson(base: string, path: string, cookie: string): Promise<{
  status: number;
  elapsedMs: number;
  body: Record<string, unknown>;
}> {
  const t0 = Date.now();
  const res = await fetch(`${base}${path}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const elapsedMs = Date.now() - t0;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, elapsedMs, body };
}

async function runOffline(): Promise<void> {
  console.log('\n═══ ENGINE HEALTH (offline) ═══');
  console.log('Running warehouse probes via validateEnginesHealth…\n');
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('npx', ['tsx', 'scripts/validateEnginesHealth.ts'], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(r.status ?? 1);
}

async function runLive(): Promise<void> {
  const base = await resolveBase();
  if (!base) {
    record('server_reachable', 'FAIL', 'No server at ENGINE_BASE_URL / :5000 / :3000 — use --offline or start server');
    printReport(null);
    process.exit(1);
  }

  let cookie: string;
  try {
    const session = await resolveSessionCookie(base);
    cookie = session.cookie;
    record('auth', 'OK', session.via);
  } catch (e) {
    record('auth', 'FAIL', e instanceof Error ? e.message : String(e));
    printReport(base);
    process.exit(1);
  }

  // ── Engine Health API ─────────────────────────────────────────
  const healthPath = '/api/signals/engine-health';
  let health = await fetchJson(base, healthPath, cookie);

  if ((health.status === 401 || health.status === 403) && hasLoginCredentials()
      && !process.env.ENGINE_AUTH_COOKIE?.trim()) {
    try {
      cookie = await login(base);
      record('auth_retry', 'OK', 'Re-logged in after 401');
      health = await fetchJson(base, healthPath, cookie);
    } catch (e) {
      record('auth_retry', 'FAIL', e instanceof Error ? e.message : String(e));
    }
  }

  if (health.status === 401 || health.status === 403) {
    record('engine_health_http', 'FAIL', `HTTP ${health.status} — unauthorized (check UI_PASSWORD)`);
    printReport(base);
    process.exit(1);
  }

  if (health.status !== 200) {
    record('engine_health_http', 'FAIL', `HTTP ${health.status} in ${health.elapsedMs}ms`);
    printReport(base);
    process.exit(1);
  }

  record('engine_health_http', 'OK', `HTTP 200 in ${health.elapsedMs}ms`);

  const healthMap = health.body.health as Record<string, unknown> | undefined;
  if (!healthMap || typeof healthMap !== 'object') {
    record('engine_health_payload', 'FAIL', 'Missing health object in response');
    printReport(base);
    process.exit(1);
  }

  const overall = String(healthMap.overallStatus ?? 'UNKNOWN');
  const summary = String(healthMap.overallSummary ?? '—');
  const nodes = Array.isArray(healthMap.nodes) ? healthMap.nodes as Array<Record<string, unknown>> : [];

  record(
    'engine_health_overall',
    overall === 'HEALTHY' ? 'OK' : overall === 'WARNING' ? 'WARN' : 'FAIL',
    `${overall} — ${summary}`,
  );

  if (nodes.length === 0) {
    record('engine_health_nodes', 'FAIL', 'health.nodes is empty');
  } else {
    record('engine_health_nodes', 'OK', `${nodes.length} pipeline nodes returned`);
  }

  const sourceStatus = health.body.sourceStatus as Record<string, { ok?: boolean; elapsedMs?: number }> | undefined;
  if (sourceStatus?.signals?.ok === false) {
    record('upstream_signals', 'WARN', `internal /api/signals failed (${health.body.degraded ? 'degraded fallback' : 'partial'})`);
  } else {
    record('upstream_signals', 'OK', `signals fetch ok (${sourceStatus?.signals?.elapsedMs ?? '?'}ms)`);
  }

  const warnings = Array.isArray(health.body.warnings) ? health.body.warnings as string[] : [];
  if (warnings.length > 0) {
    record('engine_health_warnings', 'WARN', `${warnings.length} warning(s)`);
  }

  console.log('\n── Pipeline nodes ──────────────────────');
  for (const n of nodes) {
    const status = String(n.status ?? 'UNKNOWN');
    const band: Band =
      status === 'HEALTHY' ? 'OK'
      : status === 'WARNING' ? 'WARN'
      : 'FAIL';
    const issue = (n.diagnostics as { primaryIssue?: string } | undefined)?.primaryIssue
      ?? (Array.isArray((n.diagnostics as { warnings?: string[] })?.warnings)
        ? (n.diagnostics as { warnings: string[] }).warnings[0]
        : null)
      ?? '—';
    console.log(`  ${icon(band)}  ${String(n.name ?? n.id).padEnd(28)} ${status.padEnd(18)} ${issue}`);
  }

  // ── Dashboard fusion parity ───────────────────────────────────
  const dash = await fetchJson(base, `/api/dashboard?_=${Date.now()}`, cookie);
  if (dash.status !== 200) {
    record('dashboard_http', 'FAIL', `HTTP ${dash.status}`);
  } else {
    record('dashboard_http', 'OK', `HTTP 200 in ${dash.elapsedMs}ms`);

    const fusion = (dash.body.intelligenceFusion as Record<string, Record<string, unknown>> | undefined)?.engineHealth;
    const dashStatus = fusion ? String(fusion.status ?? 'UNKNOWN') : 'MISSING';
    const expectedFusion = mapDashboardFusionStatus(overall);

    if (!fusion) {
      record('dashboard_fusion', 'FAIL', 'intelligenceFusion.engineHealth missing');
    } else if (dashStatus === 'BROKEN' && health.body.ok === true) {
      record(
        'dashboard_fusion',
        'FAIL',
        `Dashboard shows BROKEN but engine-health returned 200 — check internalFetch / INTERNAL_APP_URL (detail: ${fusion.detail ?? fusion.reason})`,
      );
    } else if (dashStatus === expectedFusion || (dashStatus === 'UNKNOWN' && expectedFusion === 'UNKNOWN')) {
      record('dashboard_fusion', 'OK', `fusion.status=${dashStatus} matches overallStatus=${overall}`);
    } else {
      record(
        'dashboard_fusion',
        'WARN',
        `fusion.status=${dashStatus} vs engine-health overallStatus=${overall} (expected fusion ${expectedFusion})`,
      );
    }

    const source = dash.body.sourceStatus as Record<string, { ok?: boolean; error?: string }> | undefined;
    if (source?.engineHealth?.ok === false) {
      record(
        'dashboard_internal_fetch',
        'FAIL',
        `Dashboard aggregator engineHealth fetch failed: ${source.engineHealth.error ?? 'unknown'} — set INTERNAL_APP_URL=http://127.0.0.1:5000`,
      );
    } else if (source?.engineHealth?.ok === true) {
      record('dashboard_internal_fetch', 'OK', 'Dashboard internal engine-health fetch succeeded');
    }
  }

  if (warnings.length > 0) {
    console.log('\n── Warnings ────────────────────────────');
    for (const w of warnings.slice(0, 8)) console.log(`  • ${w}`);
  }

  printReport(base);

  const failed = checks.some((c) => c.band === 'FAIL');
  const softFail = overall === 'DEGRADED' || overall === 'BROKEN' || overall === 'INSUFFICIENT_DATA';
  process.exit(failed || softFail ? 1 : 0);
}

function printReport(base: string | null): void {
  console.log('\n═══ ENGINE HEALTH TEST REPORT ═══');
  if (base) console.log(`Base: ${base}\n`);
  for (const c of checks) {
    console.log(`  ${icon(c.band)}  ${c.name.padEnd(28)} ${c.detail}`);
  }
  const fail = checks.filter((c) => c.band === 'FAIL').length;
  const warn = checks.filter((c) => c.band === 'WARN').length;
  const ok   = checks.filter((c) => c.band === 'OK').length;
  console.log(`\n── Summary: OK=${ok}  WARN=${warn}  FAIL=${fail} ──\n`);
}

async function main(): Promise<void> {
  if (OFFLINE) {
    await runOffline();
    return;
  }
  await runLive();
}

main().catch((e) => {
  console.error('[testEngineHealth] fatal:', e);
  process.exit(2);
});
