/**
 * Browser UI validation — manipulation health (no Playwright / headless browser).
 *
 * Exercises the same authenticated API payloads the browser pages consume:
 *   • POST /api/auth          → session cookie
 *   • GET  /api/signals/engine-health
 *   • GET  /api/signals
 *
 * Usage:
 *   npm run test:ui-manipulation
 *   UI_BASE_URL=http://localhost:3000 node scripts/uiValidateManipulationHealthHttp.mjs
 *
 * Exit 0 = PASS, 1 = FAIL
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.UI_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.UI_EMAIL ?? 'admin@quantorus365.in';
const PASSWORD = process.env.UI_PASSWORD ?? 'Admin@12345';
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), 'test-results', 'ui-manipulation-health-http');

function loadEnvLocal() {
  const path = resolve(process.cwd(), '.env.local');
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocal();
mkdirSync(OUT_DIR, { recursive: true });

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pickSessionCookie(setCookie) {
  if (!setCookie) return null;
  const chunks = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const chunk of chunks) {
    const m = /q200_session=[^;]+/.exec(chunk);
    if (m) return m[0];
  }
  return null;
}

function signalPools(payload) {
  return [
    ...(payload.developing ?? []),
    ...(payload.scanner_candidates ?? []),
    ...(payload.watchlist ?? []),
    ...(payload.signals ?? []),
    ...(payload.approved ?? []),
  ];
}

const report = { base: BASE, steps: [], ok: true };

async function login() {
  const res = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ action: 'login', email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`login HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const cookie = pickSessionCookie(res.headers.getSetCookie?.() ?? res.headers.get('set-cookie'));
  if (!cookie) fail('login succeeded but q200_session cookie missing');
  report.steps.push({ step: 'login', ok: true, status: res.status });
  return cookie;
}

async function fetchJson(path, cookie) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    fail(`${path} HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

try {
  console.log(`1. Login (${BASE})…`);
  const cookie = await login();

  console.log('2. Engine health API…');
  const healthJson = await fetchJson('/api/signals/engine-health', cookie);
  const manipNode = (healthJson.health?.nodes ?? []).find((n) => n.id === 'manipulation');
  if (!manipNode) fail('Manipulation Risk Engine node missing from health map');
  if (manipNode.status === 'NOT_CONFIGURED') {
    fail('Manipulation status is NOT_CONFIGURED on candidate cycle');
  }
  const uiStatusLabel = {
    HEALTHY: 'HEALTHY',
    DEGRADED: 'DEGRADED',
    INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
    NOT_CONFIGURED: 'NOT CONFIGURED',
    WARNING: 'WARNING',
  }[manipNode.status] ?? manipNode.status;
  report.steps.push({
    step: 'engine-health',
    ok: true,
    apiStatus: manipNode.status,
    uiStatusLabel,
    overallStatus: healthJson.health?.overallStatus,
    symbolsQueried: manipNode.metrics?.symbolsQueried,
    snapshotCount: manipNode.metrics?.snapshotCount,
    globalSnapshotCount: manipNode.metrics?.globalSnapshotCount,
  });
  console.log(`   manipulation_risk.status = ${manipNode.status} (UI label: ${uiStatusLabel})`);

  console.log('3. Signals API…');
  const signalsJson = await fetchJson('/api/signals?action=all&limit=250&forceRefresh=false', cookie);
  const meta = signalsJson.manipulationRiskMeta;
  if (!meta || typeof meta !== 'object') fail('manipulationRiskMeta missing from signals payload');
  if (!meta.configured) fail('manipulationRiskMeta.configured is false');

  const pools = signalPools(signalsJson);
  const withEnvelope = pools.filter((r) => r?.manipulationRisk != null);
  if (pools.length > 0 && withEnvelope.length === 0) {
    fail('Signal rows present but none carry manipulationRisk envelope');
  }
  report.steps.push({
    step: 'signals',
    ok: true,
    manipulationRiskMeta: meta,
    rowsWithEnvelope: `${withEnvelope.length}/${pools.length}`,
    mode: signalsJson.mode ?? 'live',
  });
  console.log(`   manipulationRiskMeta: symbolCount=${meta.symbolCount} snapshotCount=${meta.snapshotCount}`);
  console.log(`   rows with manipulationRisk: ${withEnvelope.length}/${pools.length}`);

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== HTTP UI VALIDATION REPORT ===');
  for (const step of report.steps) {
    console.log(JSON.stringify(step, null, 2));
  }
  console.log(`\nReport: ${join(OUT_DIR, 'report.json')}`);
  console.log('PASS: Browser contracts validated via authenticated HTTP (no headless browser)');
} catch (err) {
  report.ok = false;
  report.error = err instanceof Error ? err.message : String(err);
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  fail(report.error);
}
