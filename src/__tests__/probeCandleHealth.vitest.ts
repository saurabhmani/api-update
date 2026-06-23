/**
 * probeCandleHealth — Tests 1.1–1.4
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assessCoverageStats,
  type SymbolBarCount,
} from '../../scripts/probeCandleHealth';

const execFileAsync = promisify(execFile);
const SCRIPT = 'scripts/probeCandleHealth.ts';

function parseProbeStdout(stdout: string): Record<string, unknown> {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new Error('probe stdout missing JSON');
  return JSON.parse(stdout.slice(jsonStart)) as Record<string, unknown>;
}

describe('probeCandleHealth — Tests 1.1–1.4', () => {
  let payload: Record<string, unknown>;
  let coverage: Record<string, unknown>;

  beforeAll(async () => {
    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', SCRIPT],
      {
        cwd: process.cwd(),
        env: { ...process.env, DOTENV_CONFIG_PATH: '.env.local' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    payload = parseProbeStdout(stdout);
    coverage = payload.coverage as Record<string, unknown>;
  }, 130_000);

  it('1.1 — probe script executes successfully', () => {
    expect(payload).toBeDefined();
    expect(payload.coverageError ?? null).toBeNull();
    expect(payload.latestIso).toBeTruthy();
  });

  it('1.2 — output includes total symbols', () => {
    expect(coverage).toBeDefined();
    expect(typeof coverage.totalSymbols).toBe('number');
    expect(coverage.totalSymbols).toBeGreaterThan(0);
  });

  it('1.3 — output includes bars per symbol', () => {
    expect(typeof coverage.averageBarsPerSymbol).toBe('number');
    expect(coverage.averageBarsPerSymbol).toBeGreaterThanOrEqual(0);
  });

  it('1.4 — coverage deficiency identified (many symbols below 60 bars)', () => {
    // Unit contract: majority below 60 → deficiency flagged.
    const deficient: SymbolBarCount[] = Array.from({ length: 100 }, (_, i) => ({
      symbol:   `SYM${i}`,
      barCount: i < 80 ? 15 : 120,
    }));
    const mock = assessCoverageStats(deficient);
    expect(mock.symbolsBelow60Bars).toBeGreaterThan(mock.totalSymbols / 2);
    expect(mock.coverageDeficiency).toBe(true);

    // Live warehouse: deficiency should match probe output when majority < 60.
    if (typeof coverage.symbolsBelow60Bars === 'number' && typeof coverage.totalSymbols === 'number') {
      const liveMajorityBelow60 = coverage.symbolsBelow60Bars > (coverage.totalSymbols as number) / 2;
      expect(coverage.coverageDeficiency).toBe(liveMajorityBelow60);
      if (liveMajorityBelow60) {
        expect(coverage.deficiencySummary).toMatch(/fewer than 60 EOD bars/i);
      }
    }
  });
});
