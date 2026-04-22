// ════════════════════════════════════════════════════════════════
//  checkProviderConsistency.ts — scan for bypass patterns
//
//  Flags any file that imports the raw Yahoo/Kite fetchers or the
//  exchange-API libraries directly WITHOUT going through
//  MarketDataProvider.
//
//  Allowlist:
//    • src/providers/**               (the provider itself)
//    • src/lib/marketData/**          (legacy helpers that now
//                                      delegate to the provider)
//
//  Anything else importing these symbols is a violation. Exit 1 on
//  any violation so CI breaks on regressions.
//
//  Usage:
//    npm run check:provider
//    tsx scripts/checkProviderConsistency.ts --json
// ════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'src');

// Each rule is a (regex, reason) pair. The regex matches an IMPORT
// statement or a require() call that pulls a forbidden symbol from
// a forbidden module.
const VIOLATIONS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /from\s+['"]@\/lib\/marketData\/yahoo['"]/,
    reason: 'Direct import from yahoo.ts — use MarketDataProvider.',
  },
  {
    pattern: /from\s+['"]@\/lib\/marketData\/priceCache['"]/,
    reason: 'Direct import from priceCache — use MarketDataProvider.',
  },
  {
    pattern: /from\s+['"]@\/lib\/marketData\/kiteTicker['"]/,
    reason: 'Direct import from kiteTicker — use MarketDataProvider (KiteAdapter).',
  },
  {
    pattern: /from\s+['"]@\/lib\/marketData\/kiteRest['"]/,
    reason: 'Direct import from kiteRest — use MarketDataProvider.',
  },
  {
    pattern: /from\s+['"]kiteconnect['"]/,
    reason: 'Direct kiteconnect dependency — must be inside src/providers/adapters or src/lib/marketData.',
  },
  {
    pattern: /axios\.(get|post|put|delete)\s*\(\s*['"`]https:\/\/(query[12]\.)?finance\.yahoo\.com/,
    reason: 'Direct Yahoo HTTP call — use MarketDataProvider.',
  },
  {
    pattern: /fetch\s*\(\s*['"`]https:\/\/(query[12]\.)?finance\.yahoo\.com/,
    reason: 'Direct Yahoo HTTP call — use MarketDataProvider.',
  },
  {
    pattern: /from\s+['"].*yahoo-finance2.*['"]/,
    reason: 'yahoo-finance2 library is not allowed — use MarketDataProvider.',
  },
  {
    pattern: /axios\.(get|post)\s*\(\s*['"`]https:\/\/stock\.indianapi\.in/,
    reason: 'Direct IndianAPI call — must go through IndianAPIAdapter via MarketDataProvider.',
  },
];

// Allowlist prefixes (POSIX-style). Files under these paths are
// permitted to use the otherwise-forbidden imports.
const ALLOW_PREFIXES = [
  'src/providers/',                        // the provider + adapters
  'src/lib/marketData/',                   // legacy helpers that delegate
  'src/__tests__/',                        // test doubles
  'src/scripts/',                          // one-off scripts
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function isAllowed(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  return ALLOW_PREFIXES.some(prefix => p.startsWith(prefix));
}

interface Finding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
}

const jsonMode = process.argv.includes('--json');

function main(): void {
  if (!fs.existsSync(ROOT)) {
    console.error(`src/ not found at ${ROOT}`);
    process.exit(2);
  }
  const files = walk(ROOT);
  const findings: Finding[] = [];

  for (const file of files) {
    const rel = path.relative(process.cwd(), file);
    if (isAllowed(rel)) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of VIOLATIONS) {
        if (rule.pattern.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            rule: rule.reason,
            snippet: line.trim().slice(0, 160),
          });
        }
      }
    }
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ violations: findings }, null, 2) + '\n');
  } else {
    console.log(`── checkProviderConsistency ── scanned ${files.length} files under src/`);
    if (findings.length === 0) {
      console.log('✓ no violations — all market-data access routes through MarketDataProvider.');
    } else {
      console.log(`\n✗ ${findings.length} violation(s):\n`);
      for (const f of findings) {
        console.log(`  ${f.file}:${f.line}`);
        console.log(`    ${f.rule}`);
        console.log(`    > ${f.snippet}\n`);
      }
    }
  }

  process.exit(findings.length > 0 ? 1 : 0);
}

main();
