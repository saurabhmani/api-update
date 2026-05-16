/**
 * closedMarketSignals — expiry & age guard contract tests.
 *
 * Pins the SQL-layer guards that prevent expired or stale q365_signals
 * rows from leaking into the closed-market dashboard. These guards are
 * tested as source-text contracts (not via the live DB) because the
 * helpers are private to the module and the SQL strings are the
 * load-bearing artifact — a regression here would silently re-introduce
 * the "30-hour-old fallback signal" symptom users reported.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('closedMarketSignals — expiry guard on q365_signals fallback', () => {
  const src = read('src/lib/signals/closedMarketSignals.ts');

  it('strict tier filters out rows past their expires_at', () => {
    expect(src).toMatch(/AND\s+\(s\.expires_at\s+IS\s+NULL\s+OR\s+s\.expires_at\s+>\s+NOW\(\)\)/);
  });

  it('strict + relaxed tier both apply a generated_at age cutoff', () => {
    // The DATE_SUB clause MUST appear at least twice — once per tier.
    const matches = src.match(
      /AND\s+s\.generated_at\s+>=\s+DATE_SUB\(NOW\(\),\s+INTERVAL\s+\?\s+HOUR\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('exposes a configurable max-age helper with a 72h default (covers weekend Friday→Monday)', () => {
    expect(src).toMatch(/export function resolveClosedSignalsMaxAgeHours/);
    expect(src).toMatch(/CLOSED_SIGNALS_MAX_AGE_HOURS/);
    // Default raised from 24 → 72 so Sunday's "Friday close was 60h
    // ago" doesn't drop every q365_signals row.
    expect(src).toMatch(/return\s+72\s*;/);
  });

  it('clamps the max-age helper to a sane window (1h..168h)', () => {
    expect(src).toMatch(/Math\.max\(1,\s*Math\.min\(168/);
  });
});

describe('closedMarketSignals — source_kind discriminator', () => {
  const src = read('src/lib/signals/closedMarketSignals.ts');

  it('exports the ClosedSignalSourceKind union', () => {
    expect(src).toMatch(/export type ClosedSignalSourceKind\s*=\s*\n?\s*\|\s*['"]confirmed_snapshot['"]/);
    expect(src).toMatch(/\|\s*['"]q365_signals_early['"]/);
    expect(src).toMatch(/\|\s*['"]scanner_candidate['"]/);
  });

  it('q365_signals fallback rows are tagged source_kind=q365_signals_early', () => {
    // The tag is applied via a typed-property cast in `tagAsEarly`,
    // so we match either form (`key: 'value'` literal OR
    // `.source_kind = 'value'` assignment).
    expect(src).toMatch(/source_kind\s*[:=]\s*['"]q365_signals_early['"]/);
    // tagAsEarly helper must exist and set both is_relaxed + source_kind.
    expect(src).toMatch(/function tagAsEarly\(/);
  });

  it('confirmed-snapshot rows are tagged source_kind=confirmed_snapshot', () => {
    expect(src).toMatch(/source_kind\s*[:=]\s*['"]confirmed_snapshot['"]/);
  });

  it('rows routed to the side panel get source_kind=scanner_candidate', () => {
    expect(src).toMatch(/source_kind\s*[:=]\s*['"]scanner_candidate['"]/);
    expect(src).toMatch(/function asScannerCandidate\(/);
  });
});

describe('signals UI — Cycle 1 / Early Scanner Candidate badge', () => {
  const src = read('src/app/signals/page.tsx');

  it('renders the explicit "Early Scanner Candidate · Cycle N · Not Confirmed · Last Close" copy', () => {
    // Template literal in JSX, single line — `\${cyclesLabel}` interpolates the count.
    expect(src).toMatch(/Early Scanner Candidate · \$\{cyclesLabel\} · Not Confirmed · Last Close/);
  });

  it('cycle 1 rows get an inline "Cycle 1 · Needs validation" badge in the cycles cell', () => {
    expect(src).toMatch(/Cycle 1 · Needs validation/);
  });

  it('renders a hover tooltip explaining the maturity pipeline', () => {
    expect(src).toMatch(/passed only.*1 validation cycle/);
    expect(src).toMatch(/repeated detection/);
  });

  it('treats sub-3-cycle rows as not-confirmed regardless of strict/relaxed tag', () => {
    expect(src).toMatch(/cycles\s*<\s*3/);
  });
});

describe('dashboard UI — closed-market early-signal badge', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('OpportunityRow carries the maturity-tracker fields', () => {
    expect(src).toMatch(/validation_cycles_passed\?:/);
    expect(src).toMatch(/source_kind\?:\s*['"]confirmed_snapshot['"]/);
  });

  it('renders the Early Scanner Candidate badge with cycle count', () => {
    // Dashboard uses JSX expression `{cyclesLabel}`, not a template literal.
    expect(src).toMatch(/Early Scanner Candidate · \{cyclesLabel\} · Not Confirmed · Last Close/);
  });

  it('falls back to a plain "Last Close" pill only when cycles ≥ 3 and not relaxed', () => {
    expect(src).toMatch(/cycles\s*<\s*3/);
  });
});
