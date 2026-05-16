/**
 * Source-contract test for the closed-market freshness probe wiring.
 *
 * Pins the Bucket 2 fix — when the dashboard polls /api/signals on a
 * weekend, the freshness envelope must surface latest_batch_id /
 * scanner_engine_kind / persistence_percent / scan_coverage_percent
 * pulled from probeScannerBatch + loadUniverseSize, not the literal
 * `null`s the original closed-market path emitted.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('closed-market freshness — scanner-batch probe wiring', () => {
  const route = read('src/app/api/signals/route.ts');
  const svc   = read('src/lib/signals/freshnessService.ts');

  it('imports probeScannerBatch + loadUniverseSize from freshnessService', () => {
    expect(route).toMatch(/probeScannerBatch[\s\S]{0,40}loadUniverseSize/);
  });

  it('freshnessService exports probeScannerBatch + loadUniverseSize', () => {
    expect(svc).toMatch(/export async function probeScannerBatch/);
    expect(svc).toMatch(/export async function loadUniverseSize/);
  });

  it('closed-market path calls probeScannerBatch and loadUniverseSize', () => {
    // probeScannerBatch is invoked with a windowHours arg widened to
    // CLOSED_SIGNALS_MAX_AGE_HOURS so weekend polls span Friday's batch.
    expect(route).toMatch(/await\s+probeScannerBatch\(\s*\{\s*windowHours/);
    expect(route).toMatch(/await\s+loadUniverseSize\(\)/);
  });

  it('latest_batch_id is populated from the probe (no longer literal null)', () => {
    expect(route).toMatch(/latest_batch_id:\s*scannerProbe\.scannerBatchId/);
    expect(route).not.toMatch(/latest_batch_id:\s*null/);
  });

  it('latest_batch_engine_kind comes from the probe', () => {
    expect(route).toMatch(/latest_batch_engine_kind:\s*scannerProbe\.scannerEngineKind/);
  });

  it('persistence_percent / scan_coverage_percent come from the computed pct', () => {
    expect(route).toMatch(/persistence_percent:\s*scannerPersistencePct/);
    expect(route).toMatch(/scan_coverage_percent:\s*scannerPersistencePct/);
  });

  it('universe_size comes from loadUniverseSize (not null)', () => {
    expect(route).toMatch(/universe_size:\s*scannerUniverseSize/);
  });

  it('probe failures fall back gracefully without breaking the response', () => {
    // .catch() handlers must wrap both probes so a transient query
    // failure leaves the freshness envelope intact rather than
    // collapsing the entire closed-market response to a 500.
    expect(route).toMatch(/probeScannerBatch\(\s*\{\s*windowHours[^)]*\}\s*\)\.catch/);
    expect(route).toMatch(/loadUniverseSize\(\)\.catch/);
  });

  // ── Engine-kind classifier — extended prefix coverage ────────────
  it('classifier recognizes the extended batch_id prefixes', () => {
    expect(svc).toMatch(/'nse_bootstrap_'\)\s*\?\s*'bootstrap'/);
    expect(svc).toMatch(/'inproc:'\)\s*\?\s*'inproc'/);
    expect(svc).toMatch(/'scripts:'\)\s*\?\s*'script'/);
  });

  it('ScannerEngineKind union includes the new producer labels', () => {
    expect(svc).toMatch(/'bootstrap'/);
    expect(svc).toMatch(/'inproc'/);
    expect(svc).toMatch(/'script'/);
  });

  // ── tracker_counts probe ─────────────────────────────────────────
  it('closed-market path probes getTrackerCounts() instead of hardcoding zeros', () => {
    expect(route).toMatch(/import\s*\{\s*getTrackerCounts\s*\}\s*from\s*['"]@\/lib\/signal-engine\/repository\/maturityTracker['"]/);
    // Closed-market path passes a wider freshness window (typically
    // CLOSED_SIGNALS_MAX_AGE_HOURS, default 72h) so weekend polls can
    // see prior-session candidate trackers.
    expect(route).toMatch(/await\s+getTrackerCounts\(\s*\{[\s\S]*?freshHours[\s\S]*?\}\s*\)\.catch/);
    expect(route).toMatch(/tracker_counts:\s*closedTrackerCounts/);
  });

  it('does NOT emit the legacy hardcoded zero block for tracker_counts', () => {
    // The literal `tracker_counts: { candidate: 0, ...}` block was the
    // source of "all zeros" in the freshness envelope even when the
    // DB had stale candidate rows. Once the probe wires through, this
    // block must not survive in the closed-market freshness object.
    expect(route).not.toMatch(/tracker_counts:\s*\{\s*candidate:\s*0,\s*developing:\s*0,\s*mature:\s*0,\s*\n?\s*promoted:\s*0,\s*terminated:\s*0,\s*total:\s*0\s*,?\s*\}/);
  });
});
