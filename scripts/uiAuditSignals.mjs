/**
 * Headless UI audit for /signals — captures console errors, failed requests,
 * and visible error/warning banners.
 */
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE_URL ?? 'http://localhost:3000';
const EMAIL = process.env.UI_EMAIL ?? 'admin@quantorus365.in';
const PASSWORD = process.env.UI_PASSWORD ?? 'Admin@12345';

const consoleLogs = [];
const consoleErrors = [];
const consoleWarnings = [];
const failedRequests = [];
const apiResponses = [];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') consoleErrors.push(text);
    if (type === 'warning') consoleWarnings.push(text);
    if (type === 'log' && /\[TIER UI\]|\[SIGNALS|UI UPDATE|API SIGNALS|ELITE_UI|accept/i.test(text)) {
      consoleLogs.push(text);
    }
  });

  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: req.url(),
      failure: req.failure()?.errorText ?? 'unknown',
    });
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    if (status >= 400) {
      let body = '';
      try { body = (await res.text()).slice(0, 300); } catch { /* */ }
      failedRequests.push({ url, status, body });
    } else if (
      url.includes('/api/signals') ||
      url.includes('/api/data-feed') ||
      url.includes('/api/dashboard') ||
      url.includes('/api/signals/engine-health')
    ) {
      let snippet = '';
      try {
        const json = await res.json();
        snippet = JSON.stringify({
          ok: json.ok,
          warnings: json.warnings?.slice?.(0, 5),
          validation_status: json.validation_status,
          counters: json.counters,
          signal_quality: json.signal_quality,
          approved_count: json.approved_count ?? json.counters?.approvedTotal,
          signals_len: Array.isArray(json.signals) ? json.signals.length : undefined,
          error: json.error,
        });
      } catch {
        snippet = '(non-json)';
      }
      apiResponses.push({ url: url.replace(BASE, ''), status, snippet });
    }
  });

  // Login
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', EMAIL);
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'), { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(2000);

  const afterLogin = page.url();
  if (afterLogin.includes('/login')) {
    console.log(JSON.stringify({ loginFailed: true, url: afterLogin }, null, 2));
    await browser.close();
    process.exit(1);
  }

  // Signals page — wait for polls
  await page.goto(`${BASE}/signals`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(10000);

  const visibleText = await page.evaluate(() => {
    const body = document.body.innerText;
    const patterns = [
      /error/gi, /failed/gi, /unavailable/gi, /timed out/gi,
      /did not respond/gi, /unauthorized/gi, /recovery mode/gi,
      /no signals/gi, /0 candidates/gi, /stale/gi, /fallback/gi,
    ];
    const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
    const hits = lines.filter((l) => patterns.some((p) => p.test(l)));
    return [...new Set(hits)].slice(0, 40);
  });

  const counters = await page.evaluate(() => {
    const text = document.body.innerText;
    const approvedTotal = text.match(/APPROVED TOTAL[\s\S]{0,30}?(\d+)/);
    const approvedBuy   = text.match(/APPROVED BUY[\s\S]{0,30}?(\d+)/);
    const approvedSell  = text.match(/APPROVED SELL[\s\S]{0,30}?(\d+)/);
    return {
      approvedTotal: approvedTotal?.[1] ?? null,
      approvedBuy:   approvedBuy?.[1] ?? null,
      approvedSell:  approvedSell?.[1] ?? null,
    };
  });

  const tabCounts = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('button, [role="tab"]')];
    return tabs
      .map((el) => el.textContent?.trim())
      .filter((t) => t && /APPROVED|HIGH POTENTIAL|WATCHLIST|REJECTED/i.test(t))
      .slice(0, 10);
  });

  const debugState = await page.evaluate(() => ({
    q365Counts: window.__Q365_COUNTS__ ?? null,
    q365DropSig: window.__Q365_DROP_SIG__ ?? null,
    q365EliteSig: window.__Q365_ELITE_UI_SIG__ ?? null,
  }));

  // Fetch authenticated API sample from browser context
  const apiSample = await page.evaluate(async () => {
    const res = await fetch('/api/signals?action=all&limit=20&request_id=audit-ui');
    const data = await res.json();
    const first = data.signals?.[0];
    return {
      status: res.status,
      validation_status: data.validation_status,
      empty_confirmed: data.empty_confirmed,
      signal_quality: data.signal_quality,
      signals_len: data.signals?.length ?? 0,
      counters: data.counters,
      first_signal: first ? {
        symbol: first.symbol ?? first.tradingsymbol,
        direction: first.direction,
        is_relaxed: first.is_relaxed,
        is_conditional: first.is_conditional,
        is_scanner_candidate: first.is_scanner_candidate,
        signal_status: first.signal_status,
        classification: first.classification,
      } : null,
      developing_len: data.developing?.length ?? 0,
      scanner_len: data.scanner_candidates?.length ?? 0,
      high_potential_len: data.high_potential?.length ?? 0,
    };
  });

  // Screenshot path for reference
  await page.screenshot({ path: '/tmp/signals-audit.png', fullPage: true }).catch(() => null);

  const report = {
    loginUrl: afterLogin,
    signalsUrl: page.url(),
    counters,
    tabCounts,
    debugState,
    apiSample,
    visibleIssueLines: visibleText,
    apiResponses: apiResponses.slice(0, 15),
    failedRequests: failedRequests.slice(0, 20),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 30),
    consoleLogs: consoleLogs.slice(0, 20),
    consoleWarnings: [...new Set(consoleWarnings)].filter((w) =>
      !w.includes('DevTools') && !w.includes('Download the React DevTools'),
    ).slice(0, 20),
  };

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
