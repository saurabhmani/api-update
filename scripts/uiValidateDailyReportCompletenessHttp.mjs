/**
 * HTTP validation — daily report completeness after market movers (Phase 4B).
 *
 *   • POST /api/auth                    → session cookie
 *   • GET  /api/signals/daily-report    → report + warnings
 *   • GET  /api/signals/engine-health   → daily_report health node
 *
 * Usage:
 *   node scripts/uiValidateDailyReportCompletenessHttp.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BASE = (process.env.UI_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.UI_EMAIL ?? 'admin@quantorus365.in';
const PASSWORD = process.env.UI_PASSWORD ?? 'Admin@12345';
const OUT_DIR = process.env.OUT_DIR ?? join(
  process.cwd(),
  'test-results',
  'ui-daily-report-completeness-http',
);

const MARKET_MOVER_PLACEHOLDERS = [
  'Market movers dataset not configured',
  'Market movers dataset is not available yet',
  'No EOD market movers found',
];

/** Post-signal limitation themes (Scenario C). */
const ALLOWED_WARNING_RE = [
  /per-signal (price )?history/i,
  /MFE\/MAE/i,
  /time-to-target/i,
];

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

function collectWarnings(payload, dailyReport, healthNode) {
  const all = [
    ...(payload.warnings ?? []),
    ...(dailyReport.warnings ?? []),
    ...(dailyReport.signalPerformance?.insufficientDataReasons ?? []),
    ...(healthNode?.diagnostics?.warnings ?? []),
  ];
  return [...new Set(all.filter(Boolean))];
}

function isAllowedWarning(text) {
  return ALLOWED_WARNING_RE.some((re) => re.test(text));
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
  if (!dailyReport) fail('daily-report response missing report object');

  console.log('3. Engine health (daily_report node)…');
  const healthPayload = await fetchJson('/api/signals/engine-health', cookie);
  const healthNode = (healthPayload.health?.nodes ?? []).find((n) => n.id === 'daily_report');

  const serialised = JSON.stringify({ payload, healthNode });
  const allWarnings = collectWarnings(payload, dailyReport, healthNode);
  const marketMoversAvailable =
    dailyReport.marketMoversStatus === 'COMPLETE' &&
    Array.isArray(dailyReport.marketMovers) &&
    dailyReport.marketMovers.length > 0;

  // Scenario A — historical candles available
  if (!marketMoversAvailable) {
    fail('Scenario A: expected { marketMoversAvailable: true }');
  }
  report.steps.push({
    scenario: 'A',
    step: 'historical-candles-available',
    ok: true,
    marketMoversAvailable: true,
    count: dailyReport.marketMovers.length,
  });
  console.log('   Scenario A PASS — { marketMoversAvailable: true }');

  // Scenario B — stub warning removed
  for (const phrase of MARKET_MOVER_PLACEHOLDERS) {
    if (serialised.includes(phrase)) {
      fail(`Scenario B: stub warning still present: "${phrase}"`);
    }
  }
  report.steps.push({ scenario: 'B', step: 'stub-warning-removed', ok: true });
  console.log('   Scenario B PASS — "Market movers dataset not configured" removed');

  // Scenario C — post-signal warnings only
  const reasons = dailyReport.signalPerformance?.insufficientDataReasons ?? [];
  const hasPostSignalCore = reasons.some((r) => /per-signal (price )?history/i.test(r));
  if (!hasPostSignalCore) {
    fail('Scenario C: per-signal history limitation not reported');
  }
  const disallowed = allWarnings.filter((w) => !isAllowedWarning(w));
  if (disallowed.length > 0) {
    fail(`Scenario C: warnings outside post-signal scope: ${JSON.stringify(disallowed)}`);
  }
  report.steps.push({
    scenario: 'C',
    step: 'post-signal-warnings-only',
    ok: true,
    warnings: allWarnings,
    insufficientDataReasons: reasons,
    reportStatus: dailyReport.reportStatus,
    healthStatus: healthNode?.status ?? null,
  });
  console.log('   Scenario C PASS — warnings limited to per-signal history / MFE/MAE / time-to-target');

  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== DAILY REPORT SCENARIOS A–C ===');
  for (const step of report.steps) {
    console.log(JSON.stringify(step, null, 2));
  }
  console.log(`\nReport: ${join(OUT_DIR, 'report.json')}`);
  console.log('PASS: ✓ Market Movers Working ✓ Daily Report Improved ✓ No False Stub Warnings');
} catch (err) {
  report.ok = false;
  report.error = err instanceof Error ? err.message : String(err);
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  fail(report.error);
}
