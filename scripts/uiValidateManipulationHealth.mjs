/**
 * Browser UI validation — manipulation risk health + signal envelopes.
 * Saves screenshots to test-results/ui-manipulation-health/
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';

const BASE = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.UI_EMAIL ?? 'admin@quantorus365.in';
const PASSWORD = process.env.UI_PASSWORD ?? 'Admin@12345';
const OUT_DIR = process.env.OUT_DIR ?? join(process.cwd(), 'test-results', 'ui-manipulation-health');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const report = [];

try {
  console.log('1. Login…');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: join(OUT_DIR, '01-login.png'), fullPage: true });
  await page.fill('#email', EMAIL);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 });
  report.push({ step: 'login', ok: true, url: page.url() });
  await page.screenshot({ path: join(OUT_DIR, '02-after-login.png'), fullPage: true });

  console.log('2. Engine Health page…');
  const healthResPromise = page.waitForResponse(
    (r) => r.url().includes('/api/signals/engine-health') && r.status() === 200,
    { timeout: 30000 },
  );
  await page.goto(`${BASE}/signals/engine-health`, { waitUntil: 'domcontentloaded' });
  const healthRes = await healthResPromise;
  const healthJson = await healthRes.json();
  const manipNode = (healthJson.health?.nodes ?? []).find((n) => n.id === 'manipulation');
  if (!manipNode) fail('Manipulation Risk Engine node missing from health map');
  if (manipNode.status === 'NOT_CONFIGURED') {
    fail('Manipulation status is NOT_CONFIGURED on candidate cycle');
  }

  await page.waitForSelector('text=Manipulation Risk Engine', { timeout: 15000 });
  const manipCard = page.locator('text=Manipulation Risk Engine').first().locator('xpath=ancestor::div[contains(@style,"border")][1]');
  await manipCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT_DIR, '03-engine-health-full.png'), fullPage: true });
  await manipCard.screenshot({ path: join(OUT_DIR, '04-manipulation-card.png') });

  const pageBody = await page.locator('body').innerText();
  const statusLabels = ['HEALTHY', 'INSUFFICIENT DATA', 'INSUFFICIENT_DATA', 'DEGRADED', 'WARNING', 'NOT CONFIGURED'];
  const visibleStatus = statusLabels.find((l) => pageBody.includes(l.replace('_', ' ')) || pageBody.includes(l));
  report.push({
    step: 'engine-health',
    ok: true,
    apiStatus: manipNode.status,
    visibleStatus: visibleStatus ?? '(badge in card screenshot)',
    overallStatus: healthJson.health?.overallStatus,
    symbolsQueried: manipNode.metrics?.symbolsQueried,
    snapshotCount: manipNode.metrics?.snapshotCount,
  });
  console.log(`   API manipulation_risk.status = ${manipNode.status}`);
  console.log(`   UI visible status hint = ${visibleStatus ?? 'see screenshot'}`);

  console.log('3. Signals page…');
  const signalsResPromise = page.waitForResponse(
    (r) => r.url().includes('/api/signals?') && r.status() === 200,
    { timeout: 30000 },
  );
  await page.goto(`${BASE}/signals`, { waitUntil: 'domcontentloaded' });
  const signalsRes = await signalsResPromise;
  const signalsJson = await signalsRes.json();
  const meta = signalsJson.manipulationRiskMeta;
  if (!meta || typeof meta !== 'object') fail('manipulationRiskMeta missing from signals payload');
  if (!meta.configured) fail('manipulationRiskMeta.configured is false');

  const pools = [
    ...(signalsJson.developing ?? []),
    ...(signalsJson.scanner_candidates ?? []),
    ...(signalsJson.watchlist ?? []),
    ...(signalsJson.signals ?? []),
    ...(signalsJson.approved ?? []),
  ];
  const withEnvelope = pools.filter((r) => r?.manipulationRisk != null);
  if (pools.length > 0 && withEnvelope.length === 0) {
    fail('Signal rows present but none carry manipulationRisk envelope');
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT_DIR, '05-signals-page.png'), fullPage: true });
  report.push({
    step: 'signals',
    ok: true,
    manipulationRiskMeta: meta,
    rowsWithEnvelope: `${withEnvelope.length}/${pools.length}`,
    mode: signalsJson.mode ?? 'live',
  });
  console.log(`   manipulationRiskMeta: symbolCount=${meta.symbolCount} snapshotCount=${meta.snapshotCount}`);
  console.log(`   rows with manipulationRisk: ${withEnvelope.length}/${pools.length}`);

  console.log('\n=== BROWSER TEST REPORT ===');
  for (const r of report) {
    console.log(JSON.stringify(r, null, 2));
  }
  console.log(`\nScreenshots: ${OUT_DIR}`);
  console.log('PASS: Browser validation complete');
} catch (err) {
  await page.screenshot({ path: join(OUT_DIR, 'error.png'), fullPage: true }).catch(() => {});
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await browser.close();
}
