// ════════════════════════════════════════════════════════════════
//  Architecture-freeze regression test (Priority 6 / Priority 0 DoD)
//
//  Fails the build when any file under `src/` outside the provider
//  module imports a vendor adapter directly. Every market-data read
//  MUST go through `MarketDataProvider`, which is the only legal
//  consumer of `@/providers/adapters/*Adapter`.
//
//  This is the gate that keeps the frozen architecture from drifting
//  back into the code as new features get added. It complements the
//  runtime enforcer (`src/lib/marketData/enforcer.ts`) with a
//  compile-time contract.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const PROVIDER_DIR = join(SRC_ROOT, 'providers');

// Forbidden import patterns. If any file under `src/` outside the
// exempt roots below matches one of these, the test fails.
const FORBIDDEN_IMPORTS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /from ['"]@\/providers\/adapters\/(IndianAPIAdapter|YahooAdapter|KiteAdapter)['"]/,
    reason: 'Direct vendor adapter import — route the call through MarketDataProvider instead.',
  },
  {
    pattern: /from ['"]@\/providers\/adapters\/(IndianAPIAdapter|YahooAdapter|KiteAdapter)(?:['"])/,
    reason: 'Direct vendor adapter import — route the call through MarketDataProvider instead.',
  },
];

// Paths whose contents are exempt from the rule:
//   • src/providers/** — MarketDataProvider + interfaces + tests of the provider itself
//   • src/lib/marketData/batchScheduler.ts — the trigger-tier deep-fetch path
//     DELIBERATELY bypasses the provider cache to get a fresh snapshot for a
//     triggered signal. That's authorized by the Priority 1B refactor plan;
//     the call still goes through withProviderFrame() + guarded().
//   • src/__tests__/{marketDataProvider,scheduler.refactor,architectureFreeze}.vitest.ts
//     — tests that mock the adapter modules by name.
const EXEMPT_PREFIXES: ReadonlyArray<string> = [
  join('src', 'providers'),
  join('src', 'lib', 'marketData', 'batchScheduler.ts'),
  join('src', '__tests__', 'marketDataProvider.vitest.ts'),
  join('src', '__tests__', 'scheduler.refactor.test.ts'),
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
      // Skip node_modules / build dirs if they ever slip under src/.
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
      out.push(...walk(full));
      continue;
    }
    if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

describe('architecture freeze — no direct vendor adapter imports', () => {
  it('only src/providers/** may import *Adapter modules', () => {
    const offenders: Array<{ file: string; reason: string; line: string }> = [];

    for (const fileAbs of walk(SRC_ROOT)) {
      const rel = relative(process.cwd(), fileAbs);
      if (isExempt(rel)) continue;

      const source = readFileSync(fileAbs, 'utf8');
      const lines = source.split(/\r?\n/);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const { pattern, reason } of FORBIDDEN_IMPORTS) {
          if (pattern.test(line)) {
            offenders.push({ file: `${rel}:${i + 1}`, reason, line: line.trim() });
          }
        }
      }
    }

    if (offenders.length > 0) {
      // Print a readable report before failing so the developer sees every
      // violation in one shot, not one-at-a-time as they fix them.
      const report = offenders
        .map(o => `  • ${o.file}\n      ${o.line}\n      → ${o.reason}`)
        .join('\n');
      throw new Error(
        `Architecture freeze violated — ${offenders.length} direct vendor-adapter import(s) found outside src/providers/**:\n\n${report}\n\nEvery market-data read must go through MarketDataProvider (src/providers/MarketDataProvider.ts).`,
      );
    }

    expect(offenders).toEqual([]);
  });
});

describe('architecture freeze — Kite is broker/execution only', () => {
  it('KiteAdapter is not referenced by MarketDataProvider', () => {
    const providerSrc = readFileSync(
      join(PROVIDER_DIR, 'MarketDataProvider.ts'),
      'utf8',
    );
    expect(providerSrc).not.toMatch(/from ['"]\.\/adapters\/KiteAdapter['"]/);
    expect(providerSrc).not.toMatch(/import \* as Kite/);
  });
});
