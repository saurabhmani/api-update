/**
 * validatePremiumNewsFeeds — premium feed integration readiness (Tests 4.1–4.4).
 *
 * Run: npm run validate:premium-news
 */
import fs from 'fs';
import path from 'path';

const PREMIUM_SOURCES = ['corporate_filings', 'deals_feed', 'social_signals'] as const;
const URL_ENV: Record<typeof PREMIUM_SOURCES[number], string> = {
  corporate_filings: 'CORPORATE_FILINGS_API_URL',
  deals_feed:        'DEALS_FEED_API_URL',
  social_signals:    'SOCIAL_SIGNALS_API_URL',
};

const DOC_PATH = path.resolve(process.cwd(), 'docs/PREMIUM_NEWS_FEEDS.md');
const DOC_SECTIONS = [
  'Onboarding requirements',
  'Configuration hooks',
  'Disabled when URLs are empty',
  'TODO / future work',
  'No mock or stub providers',
];

type Color = 'red' | 'green' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m' };
  return `${map[col]}${s}\x1b[0m`;
}

function saveEnv(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(saved)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

async function main(): Promise<number> {
  console.log(c('dim', '\n── validatePremiumNewsFeeds (Tests 4.1–4.4) ──\n'));

  let pass = true;
  const check = (id: string, ok: boolean, detail: string) => {
    console.log(`${ok ? c('green', '✓') : c('red', '✗')} ${id}: ${detail}`);
    if (!ok) pass = false;
  };

  const envKeys = Object.values(URL_ENV);
  const saved = saveEnv(envKeys);

  try {
    const { isSourceConfigured, buildConfiguredSourcesSnapshot } = await import(
      '@/lib/news-engine/health/newsSourceHealth'
    );
    const { corporateFilingsAdapter } = await import(
      '@/lib/news-engine/ingestion/officialExchangeAdapter'
    );
    const { dealsFeedAdapter } = await import('@/lib/news-engine/ingestion/dealsFeedAdapter');
    const { socialSignalsAdapter } = await import('@/lib/news-engine/ingestion/socialSignalsAdapter');
    const { ingestFromAllSources } = await import('@/lib/news-engine/ingestion/ingestAll');

    const adapters = {
      corporate_filings: corporateFilingsAdapter,
      deals_feed:        dealsFeedAdapter,
      social_signals:    socialSignalsAdapter,
    };

    // ── Test 4.1 — empty URL values disable providers safely ─────
    for (const envKey of envKeys) {
      process.env[envKey] = '';
    }

    const emptyConfigured = PREMIUM_SOURCES.every((s) => !isSourceConfigured(s));
    const emptyFetch = await Promise.all(
      PREMIUM_SOURCES.map((s) => adapters[s].fetch('test', 5)),
    );
    const emptyIngest = await ingestFromAllSources('Indian stock market NSE', 5);
    const emptySafe = emptyConfigured
      && emptyFetch.every((items) => items.length === 0)
      && PREMIUM_SOURCES.every((s) => (emptyIngest.sourceBreakdown[s] ?? 0) === 0);

    check(
      'Test 4.1',
      emptySafe,
      emptySafe
        ? 'empty URL env values → configured=false, fetch=[], ingest=0'
        : 'provider not fully disabled on empty URLs',
    );

    for (const envKey of envKeys) {
      process.env[envKey] = '   ';
    }
    const whitespaceDisabled = PREMIUM_SOURCES.every((s) => !isSourceConfigured(s));
    const whitespaceFetch = await Promise.all(
      PREMIUM_SOURCES.map((s) => adapters[s].fetch('test', 3)),
    );
    check(
      'Test 4.1 (whitespace)',
      whitespaceDisabled && whitespaceFetch.every((items) => items.length === 0),
      'whitespace-only URLs treated as disabled',
    );

    for (const envKey of envKeys) {
      delete process.env[envKey];
    }

    // ── Test 4.2 — startup modules load without crash ────────────
    let startupOk = true;
    let startupDetail = 'modules imported';
    try {
      await import('@/lib/news-engine/pipeline/runNewsPipeline');
      await import('@/lib/news-engine/ingestion/ingestAll');
      buildConfiguredSourcesSnapshot();
      await ingestFromAllSources('Indian stock market NSE', 2);
    } catch (err) {
      startupOk = false;
      startupDetail = (err as Error).message;
    }
    check('Test 4.2', startupOk, startupDetail);

    // ── Test 4.3 — onboarding path documented ────────────────────
    const docExists = fs.existsSync(DOC_PATH);
    const docText = docExists ? fs.readFileSync(DOC_PATH, 'utf-8') : '';
    const missingSections = DOC_SECTIONS.filter((section) => !docText.includes(section));
    check(
      'Test 4.3',
      docExists && missingSections.length === 0,
      docExists
        ? missingSections.length === 0
          ? `docs/PREMIUM_NEWS_FEEDS.md (${DOC_SECTIONS.length} required sections)`
          : `missing sections: ${missingSections.join(', ')}`
        : 'docs/PREMIUM_NEWS_FEEDS.md not found',
    );

    // ── Test 4.4 — no fake data from disabled premium providers ──
    const ingest = await ingestFromAllSources('Indian stock market NSE', 10);
    const premiumItems = ingest.items.filter((item) =>
      PREMIUM_SOURCES.includes(item.sourceId as typeof PREMIUM_SOURCES[number]),
    );
    const adapterSources = await Promise.all(
      PREMIUM_SOURCES.map((s) => adapters[s].fetch('Indian stock market NSE', 10)),
    );
    const adapterHasFake = adapterSources.some((items) => items.length > 0);
    check(
      'Test 4.4',
      premiumItems.length === 0 && !adapterHasFake,
      `premium items in ingest=${premiumItems.length}, direct adapter items=0 (no mock/stub data)`,
    );
  } finally {
    restoreEnv(saved);
  }

  console.log('');
  console.log(pass ? c('green', '✓ Tests 4.1–4.4 PASSED\n') : c('red', '✗ Tests 4.1–4.4 FAILED\n'));
  return pass ? 0 : 1;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `validatePremiumNewsFeeds crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
