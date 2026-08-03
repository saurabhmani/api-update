/**
 * validateExchangeHealthScenarios — Scenarios A–D for exchange feed health.
 *
 * Run: npm run validate:exchange-health-scenarios
 *
 * A — Exchange feeds configured → official_exchange.status === HEALTHY
 * B — Premium feeds absent → integration gaps remain; ingestion succeeds
 * C — News ingestion run → exchange announcements in results
 * D — Health evaluation → no exchange configuration warnings
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

loadEnvFile(path.resolve(process.cwd(), '.env.production'));
loadEnvFile(path.resolve(process.cwd(), '.env.local'));

const PREMIUM_INTEGRATION = ['corporate_filings', 'deals_feed', 'social_signals'] as const;

type Color = 'red' | 'green' | 'yellow' | 'dim';
function c(col: Color, s: string): string {
  const map: Record<Color, string> = {
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m',
  };
  return `${map[col]}${s}\x1b[0m`;
}

async function main(): Promise<number> {
  console.log(c('dim', '\n── Exchange Health Scenarios A–D ──\n'));

  let pass = true;
  const check = (id: string, ok: boolean, detail: string) => {
    console.log(`${ok ? c('green', '✓') : c('red', '✗')} ${id}: ${detail}`);
    if (!ok) pass = false;
  };

  const { ingestFromAllSources } = await import('@/lib/news-engine/ingestion/ingestAll');
  const {
    buildProviderHealthMap,
    collectIngestionHealthWarnings,
    collectNonExchangeHealthWarnings,
    isSourceConfigured,
  } = await import('@/lib/news-engine/health/newsSourceHealth');

  const exchangeConfigured = isSourceConfigured('official_exchange');
  const ingest = await ingestFromAllSources('Indian stock market NSE', 12);
  const enriched = ingest.sourceStatus ?? [];
  const providerHealth = buildProviderHealthMap(enriched);
  const operatorWarnings = collectIngestionHealthWarnings(enriched);
  const nonExchangeWarnings = collectNonExchangeHealthWarnings(enriched);

  const official = providerHealth.official_exchange;
  const exchangeItems = ingest.items.filter(
    (i) => i.sourceId === 'official_exchange'
      || String(i.rawMeta?.source ?? '').startsWith('bse')
      || String(i.rawMeta?.source ?? '').startsWith('nse'),
  );

  // Scenario A — configured exchange feeds report HEALTHY
  check(
    'Scenario A',
    exchangeConfigured && official?.status === 'HEALTHY',
    JSON.stringify({ official_exchange: official ?? null }),
  );

  // Scenario B — premium integrations absent; system still operates
  const premiumGaps = PREMIUM_INTEGRATION.filter((s) => !isSourceConfigured(s));
  const premiumRows = enriched.filter((r) => PREMIUM_INTEGRATION.includes(r.source as typeof PREMIUM_INTEGRATION[number]));
  const premiumOptional = premiumRows.every((r) => r.status === 'OPTIONAL');
  const ingestOk = ingest.items.length > 0 && !ingest.errors.some((e) => e.includes('official_exchange'));
  check(
    'Scenario B',
    premiumGaps.length === 3 && premiumOptional && ingestOk,
    `premium gaps=[${premiumGaps.join(', ')}]; ingestion items=${ingest.items.length}; errors=${ingest.errors.length}`,
  );

  // Scenario C — exchange announcements appear in ingestion results
  check(
    'Scenario C',
    exchangeItems.length > 0,
    `${exchangeItems.length} exchange announcement(s) in ingestion results`,
  );

  // Scenario D — no exchange configuration warnings
  check(
    'Scenario D',
    nonExchangeWarnings.length === 0,
    nonExchangeWarnings.length
      ? `unexpected warnings: ${nonExchangeWarnings.join(' | ')}`
      : 'no exchange configuration warnings',
  );

  if (operatorWarnings.length > 0) {
    console.log(c('yellow', `\n  Note: ${operatorWarnings.length} non-exchange operator warning(s) remain (expected when paid keys absent).`));
  }

  console.log('');
  console.log(pass
    ? c('green', '✓ Scenarios A–D PASSED\n')
    : c('red', '✗ Scenarios A–D FAILED\n'));

  return pass ? 0 : 1;
}

main()
  .then((rc) => process.exit(rc))
  .catch((err) => {
    console.error(c('red', `validateExchangeHealthScenarios crashed: ${err?.message ?? err}`));
    process.exit(1);
  });
