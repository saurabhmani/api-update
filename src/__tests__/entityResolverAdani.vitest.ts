/**
 * entityResolver — Adani-group disambiguation contract.
 *
 * Locks the longest-alias-wins behaviour so a future regression
 * (e.g. someone reordering COMPANY_ALIASES alphabetically) cannot
 * resilently re-introduce the bug where "Adani Green Energy"
 * resolved to ADANIENT (Adani Enterprises) because the shorter
 * 'adani' alias matched first.
 *
 * The tests drive the real resolveEntities() — no mocks needed; the
 * helper is pure (text in, EntityLink[] out, no I/O).
 */
import { describe, expect, it } from 'vitest';
import { resolveEntities } from '@/lib/news-engine/entity-linking/entityResolver';

function symbols(title: string, body: string | null = null): string[] {
  return resolveEntities(title, body)
    .filter((e) => e.entityType === 'symbol')
    .map((e) => e.entityValue);
}

describe('entityResolver — Adani group disambiguation', () => {
  it('"Adani Green Energy" resolves to ADANIGREEN, NOT ADANIENT', () => {
    const syms = symbols('Adani Green Energy posts strong Q4 results');
    expect(syms).toContain('ADANIGREEN');
    expect(syms).not.toContain('ADANIENT');
  });

  it('"Adani Ports" resolves to ADANIPORTS, NOT ADANIENT', () => {
    const syms = symbols('Adani Ports announces new terminal at Mundra');
    expect(syms).toContain('ADANIPORTS');
    expect(syms).not.toContain('ADANIENT');
  });

  it('"Adani Power" resolves to ADANIPOWER, NOT ADANIENT', () => {
    const syms = symbols('Adani Power signs PPA with Bangladesh');
    expect(syms).toContain('ADANIPOWER');
    expect(syms).not.toContain('ADANIENT');
  });

  it('bare "Adani" (no group qualifier) defaults to ADANIENT', () => {
    // Generic group reference with no specific company name should
    // fall through to the conglomerate parent (Adani Enterprises).
    const syms = symbols('Adani group debt under regulatory scrutiny');
    expect(syms).toContain('ADANIENT');
  });

  it('"Adani Enterprises" pinned to ADANIENT explicitly', () => {
    const syms = symbols('Adani Enterprises Q3 earnings beat estimates');
    expect(syms).toContain('ADANIENT');
  });

  it('an article that mentions BOTH the parent and a subsidiary tags both', () => {
    // Spec: longer aliases win in their span, but a separate mention
    // of a different alias elsewhere in the text tags that one too.
    const syms = symbols(
      'Adani Green Energy IPO update; Adani Power Q4 results next week',
    );
    expect(syms).toContain('ADANIGREEN');
    expect(syms).toContain('ADANIPOWER');
    // The "Adani" prefix inside "Adani Green" / "Adani Power" must NOT
    // also tag ADANIENT — the span-blanking pass eats the alias.
    expect(syms).not.toContain('ADANIENT');
  });

  it('"Adani Energy Solutions" resolves to ADANIENSOL', () => {
    const syms = symbols('Adani Energy Solutions wins transmission bid');
    expect(syms).toContain('ADANIENSOL');
    expect(syms).not.toContain('ADANIENT');
  });

  it('"Adani Total Gas" resolves to ATGL', () => {
    const syms = symbols('Adani Total Gas expands CNG network');
    expect(syms).toContain('ATGL');
    expect(syms).not.toContain('ADANIENT');
  });

  it('"Adani Wilmar" resolves to AWL', () => {
    const syms = symbols('Adani Wilmar reports strong edible-oil sales');
    expect(syms).toContain('AWL');
    expect(syms).not.toContain('ADANIENT');
  });

  it('case-insensitive — "ADANI GREEN" still resolves to ADANIGREEN', () => {
    const syms = symbols('ADANI GREEN ENERGY GAINS 5% IN EARLY TRADE');
    expect(syms).toContain('ADANIGREEN');
    expect(syms).not.toContain('ADANIENT');
  });
});

describe('entityResolver — generic-prefix safety (regression guard)', () => {
  // Articles where only a non-Adani company contains the substring
  // "adani" must NEVER tag ADANIENT. The current implementation uses
  // word boundaries; if a future refactor regresses to `.includes()`
  // these tests catch it.
  it('does not falsely tag ADANIENT when the word "adani" never appears', () => {
    const syms = symbols('Reliance and Tata announce capex revisions');
    expect(syms).not.toContain('ADANIENT');
  });

  it('does not falsely tag the LICI alias from words that contain "lic"', () => {
    // The LIC alias is the canonical example used in the resolver
    // header to motivate the word-boundary fix. Lock it in: words
    // like "policy" / "public" / "conflict" must NOT tag LICI.
    const syms = symbols('US public-policy conflict over Iran sanctions');
    expect(syms).not.toContain('LICI');
  });
});
