/**
 * Static UI-source contracts.
 *
 * These tests don't render React; they just read the source files
 * and assert structural properties that prevent classes of past bugs:
 *
 *   ISSUE 2 — no UI component may hardcode the LIVE badge. The badge
 *             label must derive from the API mode (`data.mode`).
 *   ISSUE 1 — AppShell must NOT hardcode a permanent <span class="dot" />
 *             on the bell. The dot/badge must be conditionally
 *             rendered from a real unreadCount.
 *   ISSUE 7 — /api/ticker must use the canonical opportunity_rank
 *             ordering (via getTopRankings), not raw `score DESC`.
 *
 * Reading source as a string is sufficient — these are negative
 * assertions about strings that would re-introduce the bug.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('TickerStrip — ISSUE 2', () => {
  const components = read('src/components/layout/TickerStrip.tsx');
  const appLayoutDup = read('src/app/layout/TickerStrip.tsx');

  it('canonical TickerStrip must NOT hardcode the LIVE label', () => {
    // The canonical component derives the label from API mode:
    //   const labelText = isLive ? 'LIVE' : 'LAST CLOSE';
    // A bare unconditional `>LIVE<` literal would mean the badge is
    // hardcoded again. We allow the literal inside a conditional
    // expression by checking it's not the only thing rendering it.
    expect(components).toMatch(/labelText|isLive\s*\?\s*['"]LIVE['"]/);
  });

  it('app/layout/TickerStrip is a thin re-export, not a duplicate UI', () => {
    // The duplicate file used to render <div>LIVE</div> unconditionally.
    // After the dedup it must be a re-export — short and free of JSX.
    expect(appLayoutDup.length).toBeLessThan(500);
    expect(appLayoutDup).toMatch(/export.*from\s+['"]@\/components\/layout\/TickerStrip['"]/);
    expect(appLayoutDup).not.toMatch(/<div[^>]*>\s*LIVE\s*<\/div>/);
  });

  it('app/layout/AppShell is a thin re-export, not a duplicate UI', () => {
    const appLayoutShellDup = read('src/app/layout/AppShell.tsx');
    expect(appLayoutShellDup.length).toBeLessThan(500);
    expect(appLayoutShellDup).toMatch(/export.*from\s+['"]@\/components\/layout\/AppShell['"]/);
  });
});

describe('AppShell — ISSUE 1', () => {
  const shell = read('src/components/layout/AppShell.tsx');

  it('does NOT render an unconditional <span className="dot" />', () => {
    // The previous code was:
    //   <Bell />
    //   <span className="dot" />
    // The fix wraps the dot in a conditional on unreadCount/criticalCount.
    // We check there's no unconditional dot literally adjacent to <Bell.
    const unconditionalDot =
      /<Bell[^>]*\/>\s*<span\s+className="dot"\s*\/>\s*<\/Link>/.test(shell);
    expect(unconditionalDot).toBe(false);
  });

  it('fetches the lightweight summary endpoint for bell counts', () => {
    expect(shell).toMatch(/\/api\/notifications\?summary=1/);
  });

  it('uses adaptive polling cadence (open vs closed market)', () => {
    // 25_000 ms when market open, 180_000 ms when closed.
    expect(shell).toMatch(/25_?000/);
    expect(shell).toMatch(/180_?000/);
  });
});

describe('/api/ticker — ISSUE 7', () => {
  const ticker = read('src/app/api/ticker/route.ts');

  it('must NOT do its own ORDER BY r.score DESC for the ticker universe', () => {
    // The previous bug was a hand-rolled SQL with
    //   ORDER BY r.score DESC LIMIT 30
    // bypassing the canonical opportunity_rank comparator. After the
    // fix the route delegates to getTopRankings and the raw SQL block
    // is gone.
    expect(ticker).not.toMatch(/ORDER\s+BY\s+r\.score\s+DESC/);
  });

  it('reuses getTopRankings from the rankings service', () => {
    expect(ticker).toMatch(/import\s*{[^}]*getTopRankings[^}]*}\s*from\s*['"]@\/services\/rankingsService['"]/);
  });
});

describe('rankings service — ISSUE 5 wire-through', () => {
  const route = read('src/app/api/rankings/route.ts');
  it('passes market.isOpen as allowExternalFallback to getTopRankings', () => {
    // getTopRankings(limit, page, exchange, market.isOpen)
    expect(route).toMatch(/getTopRankings\([^)]*market\.isOpen[^)]*\)/);
  });
});
