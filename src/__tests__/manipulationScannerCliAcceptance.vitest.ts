/**
 * Test 3 — Manipulation scanner CLI acceptance (manual backfill path).
 *
 * Exercises the same entrypoint as:
 *   npx tsx src/lib/workers/manipulationScannerCli.ts
 */
import './loadEnv';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '@/lib/db';
import type { ScanRunResult } from '@/lib/workers/manipulationScanner';

const execFileAsync = promisify(execFile);
const CLI_PATH = 'src/lib/workers/manipulationScannerCli.ts';
const SNAPSHOT_TABLE = 'q365_manipulation_snapshots';

function parseCliJson(stdout: string): ScanRunResult {
  const match = stdout.match(/\{\s*"scanned":[\s\S]*"durationMs":\s*\d+\s*\}/);
  if (!match) {
    throw new Error('CLI stdout did not contain ScanRunResult JSON');
  }
  return JSON.parse(match[0]) as ScanRunResult;
}

describe('Test 3 — manipulation scanner CLI acceptance', () => {
  let stdout = '';
  let result: ScanRunResult;

  beforeAll(async () => {
    const { stdout: out } = await execFileAsync(
      'npx',
      ['tsx', CLI_PATH],
      {
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
        timeout: 180_000,
        env: { ...process.env },
      },
    );
    stdout = out;
    result = parseCliJson(stdout);
  }, 180_000);

  it('3.1 — CLI launches with scanner startup log', () => {
    expect(stdout).toMatch(/Manipulation Scanner —/);
    expect(stdout).toMatch(/\[MANIPULATION\] scan started — \d+ symbols/);
  });

  it('3.2 — universe scan completes (scanned > 0)', () => {
    expect(result.scanned).toBeGreaterThan(0);
  });

  it('3.3 — persistence succeeds (snapshotsPersisted > 0)', () => {
    expect(result.snapshotsPersisted).toBeGreaterThan(0);
  });

  it('3.4 — database verification (q365_manipulation_snapshots has rows)', async () => {
    const { rows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${SNAPSHOT_TABLE}`,
    );
    const count = Number(rows[0]?.cnt ?? 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeGreaterThanOrEqual(result.snapshotsPersisted);
  });
});
