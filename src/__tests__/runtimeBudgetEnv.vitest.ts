/**
 * Runtime budget env — .env.local contract (Tests 1.1–1.4).
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import './loadEnv';

const ENV_LOCAL = resolve(process.cwd(), '.env.local');

function parseEnvAssignments(filePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(filePath)) return map;
  for (const rawLine of readFileSync(filePath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function expectEnvValue(key: string, expected: string) {
  const file = parseEnvAssignments(ENV_LOCAL);
  expect(file.has(key), `${key} missing from .env.local`).toBe(true);
  expect(file.get(key)).toBe(expected);
  expect(process.env[key]).toBe(expected);
}

describe('runtime budget — .env.local', () => {
  it('1.1 — INDIANAPI_MONTHLY_LIMIT=100000 exists', () => {
    expectEnvValue('INDIANAPI_MONTHLY_LIMIT', '100000');
  });

  it('1.2 — INDIANAPI_EMULATED_BATCH_MAX=200 exists', () => {
    expectEnvValue('INDIANAPI_EMULATED_BATCH_MAX', '200');
  });

  it('1.3 — CANDLE_MAX_PER_CYCLE=100 exists (production-safe cap)', () => {
    expectEnvValue('CANDLE_MAX_PER_CYCLE', '100');
  });

  it('1.4 — application modules parse env without failure', async () => {
    const { INDIANAPI_MONTHLY_LIMIT, INDIANAPI_DAILY_LIMIT } = await import(
      '@/providers/adapters/indianApiUsageTracker'
    );
    const { CONFIG } = await import('@/lib/marketData/schedulerConfig');
    const { checkProductionEnvSafety } = await import('@/lib/startup/envSafetyLock');
    const { MONTHLY_PLANNING_TARGET } = await import('@/lib/marketData/providerRequestPolicy');

    expect(INDIANAPI_MONTHLY_LIMIT).toBe(100_000);
    expect(INDIANAPI_DAILY_LIMIT).toBe(4_500);
    expect(CONFIG.budget.monthlyFreeze).toBe(100_000);
    expect(CONFIG.budget.monthlySoftTarget).toBe(65_000);
    expect(CONFIG.budget.monthlySoftCap).toBe(85_000);
    expect(CONFIG.budget.monthlyHardLimit).toBe(95_000);
    expect(CONFIG.budget.dailySoftCap).toBe(4_500);
    expect(Number.isFinite(MONTHLY_PLANNING_TARGET())).toBe(true);

    // Parsing succeeds; violations are informational outside production boot.
    expect(() => checkProductionEnvSafety()).not.toThrow();
  });
});
