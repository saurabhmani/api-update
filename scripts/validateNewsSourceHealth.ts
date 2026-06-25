/**
 * validateNewsSourceHealth — Tests 3.1–3.4 for news source health reporting.
 *
 * Run: npx tsx --tsconfig tsconfig.node.json -r tsconfig-paths/register scripts/validateNewsSourceHealth.ts
 */
import fs from 'fs';
import path from 'path';

try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

type Color = 'red' | 'green' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m' };
  return `${map[col]}${s}\x1b[0m`;
}

function isOptionalUnavailable(row: {
  source: string;
  healthState?: string;
  tier?: string;
  healthMessage?: string;
}): boolean {
  return row.healthState === 'unavailable'
    && !!row.tier?.includes('optional')
    && !!row.healthMessage?.toLowerCase().includes('optional');
}

async function main(): Promise<number> {
  console.log(c('dim', '\n── validateNewsSourceHealth (Tests 3.1–3.4) ──\n'));

  let pass = true;
  const check = (id: string, ok: boolean, detail: string) => {
    console.log(`${ok ? c('green', '✓') : c('red', '✗')} ${id}: ${detail}`);
    if (!ok) pass = false;
  };

  const { officialExchangeAdapter } = await import(
    '@/lib/news-engine/ingestion/officialExchangeAdapter'
  );
  const { buildConfiguredSourcesSnapshot, enrichSourceHealth } = await import(
    '@/lib/news-engine/health/newsSourceHealth'
  );

  const exchangeItems = await officialExchangeAdapter.fetch('Indian stock market NSE', 8);
  const runAt = new Date().toISOString();
  const exchangeRow = enrichSourceHealth({
    source:        'official_exchange',
    configured:    true,
    fetched:       exchangeItems.length,
    error:         null,
    lastFetchedAt: runAt,
  }, true);

  check(
    'Test 3.1',
    exchangeRow.healthState === 'active' && exchangeItems.length > 0,
    `official_exchange → ${exchangeRow.healthState} (${exchangeItems.length} item(s))`,
  );

  for (const source of ['corporate_filings', 'deals_feed', 'social_signals'] as const) {
    const base = buildConfiguredSourcesSnapshot().find((r) => r.source === source);
    const row = base ?? enrichSourceHealth({
      source,
      configured: false,
      fetched: 0,
      error: null,
      lastFetchedAt: null,
    });
    const testId = source === 'corporate_filings' ? 'Test 3.2'
      : source === 'deals_feed' ? 'Test 3.3' : 'Test 3.4';
    check(
      testId,
      isOptionalUnavailable(row),
      `${source} → ${row.healthState} / ${row.tier} — ${row.healthMessage}`,
    );
  }

  console.log('');
  console.log(pass ? c('green', '✓ Tests 3.1–3.4 PASSED\n') : c('red', '✗ Tests 3.1–3.4 FAILED\n'));
  return pass ? 0 : 1;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `validateNewsSourceHealth crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
