// ════════════════════════════════════════════════════════════════
//  Architecture-freeze regression test
//
//  Fails the build when any file under `src/` outside the provider
//  module imports a vendor adapter directly. Every market-data read
//  MUST go through `MarketDataProvider`.
//
//  Also FORBIDS imports of decommissioned removed vendor modules anywhere
//  under src/ (including inside providers/).
// ════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');

// Contiguous names are assembled at runtime so static greps for the
// deleted modules stay clean after Phase 3.
const DECOMMISSIONED_MODULES = [
  ['Indian', 'APIAdapter'].join(''),
  ['indian', 'ApiProvider'].join(''),
  ['indian', 'ApiEndpoints'].join(''),
  ['indian', 'ApiUsageTracker'].join(''),
  ['api', 'BudgetGuard'].join(''),
  ['api', 'Quota'].join(''),
].map((name) => name); // keep list explicit for reviews

const FORBIDDEN_ADAPTER_IMPORTS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /from ['"]@\/providers\/adapters\/(YahooAdapter|KiteAdapter)['"]/,
    reason: 'Direct vendor adapter import — route the call through MarketDataProvider instead.',
  },
];

const EXEMPT_PREFIXES: ReadonlyArray<string> = [
  join('src', 'providers'),
  join('src', 'lib', 'marketData', 'providers'),
  join('src', 'lib', 'marketData', 'resolver'),
  join('src', '__tests__', 'architectureFreeze.vitest.ts'),
];

function isExempt(fileRel: string): boolean {
  return EXEMPT_PREFIXES.some(prefix => fileRel === prefix || fileRel.startsWith(prefix + sep));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('architecture freeze', () => {
  it('forbids decommissioned removed vendor / budget / quota module imports anywhere in src/', () => {
    const violations: string[] = [];
    for (const full of walk(SRC_ROOT)) {
      const rel = relative(process.cwd(), full);
      if (rel.includes(`${sep}__tests__${sep}architectureFreeze`)) continue;
      const text = readFileSync(full, 'utf8');
      for (const mod of DECOMMISSIONED_MODULES) {
        if (
          text.includes(`/${mod}`)
          || text.includes(`'${mod}'`)
          || text.includes(`"${mod}"`)
          || text.includes(`adapters/${mod}`)
          || text.includes(`providers/${mod}`)
          || text.includes(`marketData/${mod}`)
          || text.includes(`monitor/${mod}`)
        ) {
          violations.push(`${rel} references decommissioned module ${mod}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('forbids direct Yahoo/Kite adapter imports outside providers/', () => {
    const violations: string[] = [];
    for (const full of walk(SRC_ROOT)) {
      const rel = relative(process.cwd(), full);
      if (isExempt(rel)) continue;
      const text = readFileSync(full, 'utf8');
      for (const rule of FORBIDDEN_ADAPTER_IMPORTS) {
        if (rule.pattern.test(text)) {
          violations.push(`${rel}: ${rule.reason}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
