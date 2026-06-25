/**
 * validateNewsEngineHealth — post-exchange-activation news source health report.
 *
 * Run: npm run validate:news-engine-health
 *
 * Verifies:
 *   - GNews, NewsData, NewsAPI active (when keys configured)
 *   - BSE and NSE exchange feeds active
 *   - Health improves vs optional-only gaps
 *   - Operator warnings reference only premium integrations (if any)
 */
import fs from 'fs';
import path from 'path';

function loadEnvFile(filePath: string): void {
  try {
    for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* optional */ }
}

loadEnvFile(path.resolve(process.cwd(), '.env'));
loadEnvFile(path.resolve(process.cwd(), '.env.local'));

const PREMIUM_OPTIONAL = ['corporate_filings', 'deals_feed', 'social_signals'] as const;
const REQUIRED_ACTIVE = ['gnews', 'newsdata', 'newsapi'] as const;

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m',
  };
  return `${map[col]}${s}\x1b[0m`;
}

async function probeExchangeFeed(
  which: 'bse' | 'nse',
  fetch: (q: string, limit: number) => Promise<Array<{ rawMeta?: Record<string, unknown> }>>,
): Promise<{ active: boolean; count: number }> {
  const savedBse = process.env.BSE_ANNOUNCEMENTS_RSS;
  const savedNse = process.env.NSE_ANNOUNCEMENTS_RSS;
  if (which === 'bse') process.env.NSE_ANNOUNCEMENTS_RSS = '';
  else process.env.BSE_ANNOUNCEMENTS_RSS = '';
  try {
    const items = await fetch('Indian stock market NSE', 8);
    const prefix = which === 'bse' ? 'bse' : 'nse';
    const matched = items.filter((i) => String(i.rawMeta?.source ?? '').startsWith(prefix));
    return { active: matched.length > 0, count: matched.length };
  } finally {
    if (savedBse === undefined) delete process.env.BSE_ANNOUNCEMENTS_RSS;
    else process.env.BSE_ANNOUNCEMENTS_RSS = savedBse;
    if (savedNse === undefined) delete process.env.NSE_ANNOUNCEMENTS_RSS;
    else process.env.NSE_ANNOUNCEMENTS_RSS = savedNse;
  }
}

function warningReferencesOnlyPremium(warnings: string[]): boolean {
  if (warnings.length === 0) return true;
  const allowed = ['corporate filings', 'deals feed', 'social signals', 'CORPORATE_FILINGS', 'DEALS_FEED', 'SOCIAL_SIGNALS'];
  return warnings.every((w) => allowed.some((token) => w.toLowerCase().includes(token.toLowerCase())));
}

async function main(): Promise<number> {
  console.log(c('dim', '\n── News Engine Health Report (post exchange activation) ──\n'));

  let pass = true;
  const check = (id: string, ok: boolean, detail: string) => {
    console.log(`${ok ? c('green', '✓') : c('red', '✗')} ${id}: ${detail}`);
    if (!ok) pass = false;
  };

  const { ingestFromAllSources } = await import('@/lib/news-engine/ingestion/ingestAll');
  const { officialExchangeAdapter } = await import('@/lib/news-engine/ingestion/officialExchangeAdapter');
  const {
    buildConfiguredSourcesSnapshot,
    buildSourceHealthSummary,
    collectIngestionHealthWarnings,
    isSourceConfigured,
    attachExchangeFeedHealth,
  } = await import('@/lib/news-engine/health/newsSourceHealth');

  const ingest = await ingestFromAllSources('Indian stock market NSE', 12);
  const enriched = ingest.sourceStatus ?? [];
  const operatorWarnings = collectIngestionHealthWarnings(enriched);
  let summary = buildSourceHealthSummary(enriched, ingest.errors);
  summary = attachExchangeFeedHealth(summary, ingest.items);

  const integrationGaps = summary.integrationGaps ?? [];
  const gapsOk = integrationGaps.length === 3
    && integrationGaps.every((s) => PREMIUM_OPTIONAL.includes(s as typeof PREMIUM_OPTIONAL[number]));

  const row = (source: string) => enriched.find((s) => s.source === source);

  // Paid media APIs
  for (const source of REQUIRED_ACTIVE) {
    const r = row(source);
    const configured = isSourceConfigured(source as typeof REQUIRED_ACTIVE[number]);
    check(
      source,
      configured && r?.healthState === 'active' && (r?.fetched ?? 0) > 0,
      configured
        ? `${r?.healthState ?? 'unknown'} — ${r?.fetched ?? 0} item(s) — ${r?.healthMessage ?? ''}`
        : `NOT_CONFIGURED — set ${r?.displayName ?? source} API key in .env.local`,
    );
  }

  // BSE / NSE exchange sub-feeds
  const bseProbe = await probeExchangeFeed('bse', officialExchangeAdapter.fetch.bind(officialExchangeAdapter));
  const nseProbe = await probeExchangeFeed('nse', officialExchangeAdapter.fetch.bind(officialExchangeAdapter));
  const official = row('official_exchange');

  check('bse_rss', bseProbe.active, bseProbe.active
    ? `active — ${bseProbe.count} announcement(s)`
    : 'fetch returned 0 items');
  check('nse_rss', nseProbe.active, nseProbe.active
    ? `active — ${nseProbe.count} announcement(s)`
    : 'fetch returned 0 items');
  check(
    'official_exchange',
    official?.healthState === 'active' && (official?.fetched ?? 0) > 0,
    `${official?.healthState ?? 'unknown'} — ${official?.fetched ?? 0} item(s) combined`,
  );

  // Health summary
  console.log(c('dim', '\n── Summary ──'));
  console.log(`  configured: ${summary.configuredCount}/${summary.sources.length}`);
  console.log(`  active:     ${summary.activeCount} [${summary.activeSources.join(', ')}]`);
  console.log(`  optional:   ${summary.optionalCount} [${summary.optionalSources.join(', ') || '—'}]`);
  console.log(`  unavailable optional integrations: [${PREMIUM_OPTIONAL.filter((s) => summary.unavailableSources.includes(s)).join(', ')}]`);

  const healthImproved = summary.activeSources.includes('official_exchange')
    && bseProbe.active && nseProbe.active
    && gapsOk
    && summary.notConfiguredCount === 0;
  check('health.improved', healthImproved, `${summary.activeCount} active; integration gaps=[${integrationGaps.join(', ')}]`);

  // Premium optional integrations — expected unavailable, not operator warnings
  for (const source of PREMIUM_OPTIONAL) {
    const r = row(source);
    const ok = r?.healthState === 'unavailable'
      && r?.tier === 'optional_integration'
      && !r?.configured;
    check(`optional.${source}`, ok, r?.healthMessage ?? 'missing status row');
  }

  check(
    'warnings.premium_only',
    warningReferencesOnlyPremium(operatorWarnings) && gapsOk,
    operatorWarnings.length
      ? `warnings: ${operatorWarnings.join(' | ')}`
      : `integration gaps only: [${integrationGaps.join(', ')}]`,
  );

  if (summary.exchangeFeeds) {
    console.log(c('dim', '\n── Exchange sub-feeds ──'));
    console.log(`  BSE: ${summary.exchangeFeeds.bse.active ? 'active' : 'inactive'} (${summary.exchangeFeeds.bse.fetched} items)`);
    console.log(`  NSE: ${summary.exchangeFeeds.nse.active ? 'active' : 'inactive'} (${summary.exchangeFeeds.nse.fetched} items)`);
  }

  console.log(c('dim', '\n── Per-source status ──'));
  for (const s of enriched) {
    const icon = s.healthState === 'active' ? c('green', '●')
      : s.healthState === 'unavailable' && s.tier === 'optional_integration' ? c('yellow', '○')
      : c('dim', '·');
    console.log(`  ${icon} ${s.source.padEnd(20)} ${s.healthState?.padEnd(14)} fetched=${String(s.fetched).padStart(2)}  ${s.healthMessage}`);
  }

  console.log('');
  console.log(pass
    ? c('green', '✓ News engine health validation PASSED\n')
    : c('red', '✗ News engine health validation FAILED\n'));

  return pass ? 0 : 1;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `validateNewsEngineHealth crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
