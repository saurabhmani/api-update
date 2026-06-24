/**
 * validateExchangeRssIngestion — verify BSE/NSE announcement ingestion.
 *
 * Run: npm run validate:exchange-rss
 *
 * Checks:
 *   1. BSE feed fetches successfully
 *   2. NSE feed fetches successfully
 *   3. Items transform into RawNewsItem records
 *   4. Malformed payloads log parse errors (simulated)
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

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m',
  };
  return `${map[col]}${s}\x1b[0m`;
}

async function main(): Promise<number> {
  console.log(c('dim', '\n── validateExchangeRssIngestion ──\n'));

  let pass = true;
  const check = (id: string, ok: boolean, detail: string) => {
    console.log(`${ok ? c('green', '✓') : c('red', '✗')} ${id}: ${detail}`);
    if (!ok) pass = false;
  };

  const bseUrl = process.env.BSE_ANNOUNCEMENTS_RSS?.trim();
  const nseUrl = process.env.NSE_ANNOUNCEMENTS_RSS?.trim();
  check('env.bse', !!bseUrl, bseUrl ?? 'BSE_ANNOUNCEMENTS_RSS missing');
  check('env.nse', !!nseUrl, nseUrl ?? 'NSE_ANNOUNCEMENTS_RSS missing');

  const { officialExchangeAdapter } = await import(
    '@/lib/news-engine/ingestion/officialExchangeAdapter'
  );
  const { ingestFromAllSources } = await import('@/lib/news-engine/ingestion/ingestAll');

  const items = await officialExchangeAdapter.fetch('Indian stock market NSE', 15);
  const bseItems = items.filter((i) => String(i.rawMeta?.source ?? '').startsWith('bse'));
  const nseItems = items.filter((i) => String(i.rawMeta?.source ?? '').startsWith('nse'));
  const rssItems = items.filter((i) => i.rawMeta?.feedFormat === 'rss');

  check('fetch.bse', bseItems.length > 0, `${bseItems.length} BSE announcement(s)`);
  check('fetch.nse', nseItems.length > 0, `${nseItems.length} NSE announcement(s)`);
  check(
    'transform.records',
    items.length > 0 && items.every((i) => i.title && i.sourceId === 'official_exchange'),
    `${items.length} RawNewsItem record(s) with title + sourceId`,
  );

  if (items[0]) {
    const sample = items[0];
    console.log(c('dim', `  sample: [${sample.rawMeta?.source}] ${sample.title.slice(0, 72)}…`));
  }

  const registry = ingestFromAllSources;
  check('registry.adapter', typeof registry === 'function', 'ingestFromAllSources registered');

  const snapshot = (await import('@/lib/news-engine/ingestion/ingestAll')).getConfiguredSourcesSnapshot();
  const official = snapshot.find((s) => s.source === 'official_exchange');
  check(
    'registry.official_exchange',
    !!official?.configured,
    official?.configured ? 'official_exchange configured=true' : 'not configured',
  );

  // Parse-error logging: malformed JSON should return zero items and emit error log
  const stderrChunks: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    stderrChunks.push(String(chunk));
    return origStderrWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;

  const { parseExchangeFeedText } = await import(
    '@/lib/news-engine/ingestion/officialExchangeAdapter'
  );
  const badParse = parseExchangeFeedText('nse', '{not-json', 5);
  process.stderr.write = origStderrWrite;

  check('parse.bad_json', badParse.length === 0, 'malformed JSON returns 0 items');
  check(
    'logging.parse_errors',
    stderrChunks.some((line) => line.includes('Exchange feed JSON parse failed')),
    'parse failures emit structured error log',
  );

  if (rssItems.length > 0) {
    console.log(c('dim', `  note: ${rssItems.length} item(s) from legacy RSS format`));
  }

  console.log('');
  console.log(
    pass
      ? c('green', '✓ validateExchangeRssIngestion PASSED\n')
      : c('red', '✗ validateExchangeRssIngestion FAILED\n'),
  );
  return pass ? 0 : 1;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `validateExchangeRssIngestion crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
