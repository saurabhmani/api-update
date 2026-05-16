/**
 * "Last Close Top Losers" data-source contract tests.
 *
 * Pins the fix for the production-only regression where the dashboard
 * rendered "Last close losers unavailable" while the rankings page
 * (same DB) showed both positive and negative pct_change rows. Three
 * load-bearing pieces of behavior are asserted here so the failure
 * mode cannot drift back in:
 *
 *   1. The dashboard widens the rankings fetch from 50 → 200 rows so
 *      the loser fallback has a wide enough opportunity_rank window
 *      to find genuine decliners on a strongly bullish day.
 *
 *   2. The dashboard's filter coerces pct_change with `Number(...)`
 *      before testing finiteness, so DECIMAL columns shipped as
 *      strings (mysql2 default `decimalNumbers: false`) cannot be
 *      silently dropped by `Number.isFinite("-1.25") === false`.
 *
 *   3. The `getMoversMysql` helper has an explicit sign filter:
 *      losers → `pct_change < 0`, gainers → `pct_change > 0`. Without
 *      this, the `ORDER BY pct_change ASC LIMIT 10` form would return
 *      the smallest POSITIVE values (mislabeled "losers") whenever
 *      the rankings table happened to have no negatives.
 *
 *   4. The in-process / Redis intel cache is only valid when BOTH
 *      sides of the movers list are populated. A half-empty result
 *      from a transient sweep used to stay cached for the entire
 *      MEM_CACHE_TTL_MS, which is exactly how production kept
 *      rendering "Last close losers unavailable" for 60s windows.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('Dashboard rankings fetch — wide universe (item 1)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('fetches /api/rankings with limit=200 (was 50)', () => {
    expect(src).toMatch(/['"]\/api\/rankings\?limit=200['"]/);
    // The 50-row fetch has been retired — flag any regression.
    expect(src).not.toMatch(/['"]\/api\/rankings\?limit=50['"]/);
  });
});

describe('Dashboard movers — robust numeric coercion (item 2)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('exposes a toFiniteNum helper used by the movers derivation', () => {
    expect(src).toMatch(/const toFiniteNum\s*=\s*\(v:\s*unknown\)/);
  });

  it('rankingsLosers filters via the coerced numeric value', () => {
    // The previous implementation used
    //   .filter(r => Number.isFinite(r.pct_change) && r.pct_change < 0)
    // which silently dropped numeric-string DECIMAL values. After the
    // fix the filter calls toFiniteNum first, then compares the coerced
    // value — both "-1.25" (string) and -1.25 (number) survive.
    expect(src).toMatch(/const rankingsLosers\s*=\s*rankings[\s\S]{0,400}toFiniteNum/);
  });

  it('removes the brittle Number.isFinite(r.pct_change) form', () => {
    // The fragile form (which fails on numeric strings) MUST NOT
    // survive in the movers derivation block.
    const losersBlock = src.match(
      /const rankingsLosers\s*=\s*rankings[\s\S]{0,400}\.slice\(0,\s*5\)/,
    );
    expect(losersBlock).not.toBeNull();
    expect(losersBlock![0]).not.toMatch(/Number\.isFinite\(r\.pct_change\)/);
  });
});

describe('marketIntelligenceService — sign-filtered movers (item 3)', () => {
  const src = read('src/services/marketIntelligenceService.ts');

  it('getMoversMysql applies a sign filter so wrong-signed rows cannot leak', () => {
    // Both branches must render an explicit AND clause on pct_change.
    expect(src).toMatch(/r\.pct_change\s*>\s*0/);
    expect(src).toMatch(/r\.pct_change\s*<\s*0/);
    // A signFilter variable threaded into the SQL.
    expect(src).toMatch(/signFilter\s*=\s*type\s*===\s*['"]gainers['"]/);
  });

  it('post-coercion sign re-check survives a 0.0000 DECIMAL row', () => {
    // The defensive .filter after the toNum mapping. If a future
    // refactor drops it, the dashboard's `change_percent < 0`
    // filter would once again be the only line of defense.
    expect(src).toMatch(/return mapped\.filter\(m\s*=>\s*\n?\s*type\s*===\s*['"]gainers['"]/);
  });
});

describe('marketIntelligenceService — half-empty cache invalidation (item 4)', () => {
  const src = read('src/services/marketIntelligenceService.ts');

  it('memcache is invalid when EITHER side of the movers list is empty', () => {
    // The previous gate only checked top_gainers. The fix requires
    // both sides — without this, a transient bullish sweep with
    // gainers=10 / losers=0 stayed cached for the full TTL.
    expect(src).toMatch(/_memCache\.top_gainers\.length\s*>\s*0\s*&&[\s\S]{0,200}_memCache\.top_losers\.length\s*>\s*0/);
  });

  it('Redis cache hit applies the same both-sides gate', () => {
    expect(src).toMatch(
      /cached\.top_gainers\?\.length\s*>\s*0[\s\S]{0,200}cached\.top_losers\?\.length\s*>\s*0/,
    );
  });
});

describe('marketIntelligenceService — diagnostic logging (item 5)', () => {
  const src = read('src/services/marketIntelligenceService.ts');

  it('logs total / pos / neg counts when fallback runs', () => {
    expect(src).toMatch(/rankings movers diagnostic/);
    expect(src).toMatch(/total=\$\{toNum\(r\.total\)\}\s*pos=\$\{toNum\(r\.pos\)\}\s*neg=\$\{toNum\(r\.neg\)\}/);
  });

  it('logs the empty-fallback case explicitly so 0 rows is not silent', () => {
    expect(src).toMatch(/losers fallback returned 0 rows — DB has no negative pct_change/);
    expect(src).toMatch(/gainers fallback returned 0 rows — DB has no positive pct_change/);
  });
});

// ── Behavioural mirror tests — derivation math against synthetic data ──
describe('movers derivation — behavioural mirror', () => {
  // Mirror of the dashboard's toFiniteNum + filter pipeline. Drift
  // between this mirror and the source above is caught by the regex
  // tests; the mirror lets us assert the math directly.
  function toFiniteNum(v: unknown): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  type Row = { symbol: string; name: string; ltp: unknown; pct_change: unknown };
  function deriveLosers(rows: Row[]): Array<{ symbol: string; change_percent: number }> {
    return rows
      .map((r) => {
        const pct = toFiniteNum(r.pct_change);
        const ltp = toFiniteNum(r.ltp) ?? 0;
        return pct == null ? null : { symbol: r.symbol, name: r.name, ltp, change_percent: pct };
      })
      .filter((r): r is NonNullable<typeof r> => r != null && r.change_percent < 0)
      .sort((a, b) => a.change_percent - b.change_percent)
      .slice(0, 5);
  }

  it('numeric-string pct_change is treated as a number — DECIMAL-as-string survives', () => {
    // The exact production failure mode. mysql2 with the default
    // decimalNumbers=false ships DECIMAL(8,4) values as strings.
    const rows: Row[] = [
      { symbol: 'AAA', name: 'A', ltp: '100', pct_change: '-2.5000' },
      { symbol: 'BBB', name: 'B', ltp: '200', pct_change: '-1.2500' },
      { symbol: 'CCC', name: 'C', ltp: '50',  pct_change:  '1.7500' },
    ];
    const losers = deriveLosers(rows);
    expect(losers.map((l) => l.symbol)).toEqual(['AAA', 'BBB']);
    // change_percent is the coerced number, never the original string.
    expect(losers[0].change_percent).toBe(-2.5);
  });

  it('losers come out sorted most-negative first', () => {
    const rows: Row[] = [
      { symbol: 'X', name: 'X', ltp: 1, pct_change: -0.5 },
      { symbol: 'Y', name: 'Y', ltp: 1, pct_change: -7.2 },
      { symbol: 'Z', name: 'Z', ltp: 1, pct_change: -3.0 },
    ];
    const losers = deriveLosers(rows);
    expect(losers.map((l) => l.symbol)).toEqual(['Y', 'Z', 'X']);
  });

  it('zero-pct rows are NOT misclassified as losers', () => {
    const rows: Row[] = [
      { symbol: 'A', name: 'A', ltp: 1, pct_change: 0 },
      { symbol: 'B', name: 'B', ltp: 1, pct_change: '0.0000' },
      { symbol: 'C', name: 'C', ltp: 1, pct_change: -0.01 },
    ];
    const losers = deriveLosers(rows);
    expect(losers.map((l) => l.symbol)).toEqual(['C']);
  });

  it('null/undefined/NaN pct_change rows are dropped, not coerced to 0', () => {
    const rows: Row[] = [
      { symbol: 'A', name: 'A', ltp: 1, pct_change: null },
      { symbol: 'B', name: 'B', ltp: 1, pct_change: undefined },
      { symbol: 'C', name: 'C', ltp: 1, pct_change: 'NaN' },
      { symbol: 'D', name: 'D', ltp: 1, pct_change: -1.5 },
    ];
    const losers = deriveLosers(rows);
    expect(losers).toHaveLength(1);
    expect(losers[0].symbol).toBe('D');
  });

  it('an all-positive top-50 still returns losers when the 200-row pool has them', () => {
    // Reproduces the production scenario: top-50 by opportunity_rank
    // is all positive (strongly bullish day), but rows 50–199 contain
    // genuine decliners. The widened limit=200 fetch gives the
    // derivation the breadth it needs to find them.
    const rows: Row[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push({ symbol: `POS${i}`, name: `P${i}`, ltp: 100, pct_change: 1 + i * 0.05 });
    }
    for (let i = 0; i < 10; i++) {
      rows.push({ symbol: `NEG${i}`, name: `N${i}`, ltp: 100, pct_change: -0.5 - i * 0.1 });
    }
    const losers = deriveLosers(rows);
    expect(losers).toHaveLength(5);
    expect(losers.every((l) => l.symbol.startsWith('NEG'))).toBe(true);
    // Most-negative comes first.
    expect(losers[0].symbol).toBe('NEG9');
  });
});
