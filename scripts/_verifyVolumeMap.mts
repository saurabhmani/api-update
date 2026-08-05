import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
dotenvConfig({ path: resolve(process.cwd(), '.env.local') });

async function main() {
  const { getHistorical } = await import('../src/providers/adapters/IndianAPIAdapter');
  const { mapHistorical } = await import('../src/lib/marketData/providers/indianApiMappers');
  // Direct adapter call (already mapped)
  const series = await getHistorical('RELIANCE', '1mo', 'diag-volume-fix');
  const withVol = series.candles.filter((c) => c.v > 0).length;
  console.log(JSON.stringify({
    total: series.candles.length,
    withVol,
    sample: series.candles.slice(-3),
  }, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
