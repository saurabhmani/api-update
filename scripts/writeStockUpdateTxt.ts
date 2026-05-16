/**
 * Generate stockUpdate.txt at the project root from the bundled
 * nseUniverse.json. The custom-universe loader's default fallback is
 * <cwd>/stockUpdate.txt, so creating this file makes the universe load
 * even without setting CUSTOM_UNIVERSE_PATH.
 *
 * Run:
 *   cd /var/www/api-update
 *   npx tsx scripts/writeStockUpdateTxt.ts
 *
 * Output:
 *   /var/www/api-update/stockUpdate.txt — one symbol per line, 2767 lines.
 */

import { writeFileSync } from 'node:fs';
import { resolve }       from 'node:path';
import nseUniverse       from '../src/lib/signal-engine/constants/nseUniverse.json';

const OUT = resolve(process.cwd(), 'stockUpdate.txt');

const symbols = (nseUniverse as any).symbols as string[];
if (!Array.isArray(symbols) || symbols.length === 0) {
  console.error('FAIL — nseUniverse.json has no symbols array');
  process.exit(1);
}

// Header comment + one symbol per line. The loader strips '#' lines and blanks.
const body = [
  '# NSE universe — generated from nseUniverse.json',
  `# count: ${symbols.length}`,
  `# generated_at: ${new Date().toISOString()}`,
  '',
  ...symbols,
  '',
].join('\n');

writeFileSync(OUT, body, 'utf8');
console.log('OK — wrote', symbols.length, 'symbols to', OUT);
