/**
 * HTTP validation — daily report market movers (Tests 3.1–3.4).
 *
 *   • POST /api/auth              → session cookie
 *   • GET  /api/signals/daily-report → report.marketMovers
 *
 * Usage:
 *   node scripts/uiValidateDailyReportMoversHttp.mjs
 *   UI_BASE_URL=http://localhost:3000 node scripts/uiValidateDailyReportMoversHttp.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.UI_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.UI_EMAIL ?? 'admin@quantorus365.in';
const PASSWORD = process.env.UI_PASSWORD ?? 'Admin@12345';
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), 'test-results', 'ui-daily-report-movers-http');

const PLACEHOLDER_NOT_CONFIGURED = 'Market movers dataset not configured';
const PLACEHOLDER_NOT_AVAILABLE = 'Market movers dataset is not available yet';

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

  console.log('2. Daily report API…');
  const payload = await fetchJson('/api/signals/daily-report', cookie);
  const dailyReport = payload.report;
  if (!dailyReport || typeof dailyReport !== 'object') {
    fail('daily-report response missing report object');
  }

  const movers = dailyReport.marketMovers ?? [];
  const serialised = JSON.stringify(payload);

  // Test 3.1
  if (!Array.isArray(movers) || movers.length === 0) {
    fail('Test 3.1: report.marketMovers is empty — expected records from candles EOD');
  }
  report.steps.push({
    step: '3.1-marketMovers',
    ok: true,
    count: movers.length,
    sample: movers[0],
    marketMoversStatus: dailyReport.marketMoversStatus,
  });
  console.log(`   3.1 PASS — marketMovers.length = ${movers.length}`);

  // Test 3.2
  if (serialised.includes(PLACEHOLDER_NOT_CONFIGURED) || serialised.includes(PLACEHOLDER_NOT_AVAILABLE)) {
    fail('Test 3.2: placeholder warning still present when movers exist');
  }
  if (dailyReport.missedOpportunitiesStatus === 'INSUFFICIENT_DATA') {
    fail('Test 3.2: missedOpportunitiesStatus is still INSUFFICIENT_DATA');
  }
  report.steps.push({
    step: '3.2-no-placeholder',
    ok: true,
    missedOpportunitiesStatus: dailyReport.missedOpportunitiesStatus,
    warnings: payload.warnings ?? [],
  });
  console.log('   3.2 PASS — placeholder warnings absent');

  // Test 3.3
  const gainers = movers.filter((m) => m.direction === 'UP');
  const losers = movers.filter((m) => m.direction === 'DOWN');
  if (gainers.length === 0 || losers.length === 0) {
    fail(`Test 3.3: expected both gainers and losers (got ${gainers.length} UP, ${losers.length} DOWN)`);
  }
  const pageSource = readFileSync(
    resolve(process.cwd(), 'src/app/signals/daily-report/page.tsx'),
    'utf8',
  );
  if (!pageSource.includes('Top Gainers') || !pageSource.includes('Top Losers')) {
    fail('Test 3.3: daily-report page missing Top Gainers / Top Losers sections');
  }
  report.steps.push({
    step: '3.3-gainers-losers',
    ok: true,
    gainers: gainers.length,
    losers: losers.length,
    topGainer: gainers[0]?.symbol,
    topLoser: losers[0]?.symbol,
  });
  console.log(`   3.3 PASS — gainers=${gainers.length} losers=${losers.length}`);

  // Test 3.4
  const withVolume = movers.filter((m) => m.volume != null && Number(m.volume) > 0);
  if (withVolume.length === 0) {
    fail('Test 3.4: no market movers have volume populated');
  }
  report.steps.push({
    step: '3.4-volume',
    ok: true,
    withVolume: withVolume.length,
    sampleVolume: withVolume[0]?.volume,
  });
  console.log(`   3.4 PASS — volume populated on ${withVolume.length}/${movers.length} movers`);

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== DAILY REPORT MOVERS HTTP VALIDATION ===');
  for (const step of report.steps) {
    console.log(JSON.stringify(step, null, 2));
  }
  console.log(`\nReport: ${join(OUT_DIR, 'report.json')}`);
  console.log('PASS: Tests 3.1–3.4 validated via /api/signals/daily-report');
} catch (err) {
  report.ok = false;
  report.error = err instanceof Error ? err.message : String(err);
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  fail(report.error);
}
