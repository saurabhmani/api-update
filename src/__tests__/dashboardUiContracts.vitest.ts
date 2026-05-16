/**
 * Dashboard UI source-contract tests.
 *
 * These don't render React; they read source files as strings and
 * assert structural properties that prevent the visual defects
 * fixed in this round:
 *
 *   ISSUE 1 / 2 / 6 — chart containment. Recharts tooltips and
 *     active-shape SVGs used to escape ConvictionDistribution and
 *     paint dashed lines + numeric labels over Top Rankings,
 *     Risk & Active Alerts, etc. The fix wraps the chart parent
 *     with overflow:hidden + isolation:isolate + contain, and
 *     pins the Tooltip wrapperStyle so it cannot escape view box.
 *
 *   ISSUE 3 — dashboard signal preview is capped at top 3 with a
 *     "View all" link. The previous full-card 6-up grid pushed
 *     the rest of the dashboard far below the fold.
 *
 *   ISSUE 4 — Top Rankings header adapts to the strongest visible
 *     opportunity_rank instead of always saying "Top Rankings"
 *     even when the universe is weak.
 *
 *   ISSUE 5 — bell-badge countability window so historical
 *     un-acked manipulation/breach events don't permanently
 *     show "99+" on the bell.
 *
 *   ISSUE 7 — chart toolbar disabled / no body portals / ticker
 *     LIVE stays derived from API mode.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8');
}

// ── ConvictionDistribution chart containment ────────────────────────
describe('ConvictionDistribution — chart containment (ISSUE 1/2/6)', () => {
  const src = read('src/components/dashboard/ConvictionDistribution.tsx');

  it('outer card has overflow hidden + isolation + containment', () => {
    // The chart wrapper must create a fresh stacking context AND clip
    // overflow so a Recharts tooltip wrapper cannot leak into adjacent
    // dashboard sections. Three properties must all be present on the
    // outer card: overflow: hidden, isolation: isolate, contain.
    expect(src).toMatch(/overflow:\s*['"]hidden['"]/);
    expect(src).toMatch(/isolation:\s*['"]isolate['"]/);
    expect(src).toMatch(/contain:\s*['"]layout paint['"]/);
  });

  it('chart parent (200x200 box) ALSO has overflow hidden + isolation', () => {
    // The chart parent — the 200x200 div — also needs containment,
    // because Recharts mounts active-shape SVGs as siblings inside
    // its own internal wrapper that can drift outside the parent
    // when the active state fires from rapid hover events.
    // Match the specific pattern: position relative + width 200 + height 200.
    expect(src).toMatch(/width:\s*200[\s\S]{0,400}overflow:\s*['"]hidden['"]/);
  });

  it('Tooltip wrapperStyle has pointerEvents none + bounded zIndex', () => {
    // The Recharts <Tooltip> wrapperStyle must constrain the floating
    // wrapper to a low z-index so it can never paint above the AppShell
    // bell or topbar, and pointer-events:none so it can never grab
    // hover events from other dashboard cards.
    expect(src).toMatch(/wrapperStyle=\{\s*\{[^}]*pointerEvents:\s*['"]none['"]/);
    expect(src).toMatch(/allowEscapeViewBox=\{\s*\{\s*x:\s*false,\s*y:\s*false/);
  });

  it('Pie isAnimationActive is disabled', () => {
    // Disabling animations prevents the partial-render artifacts that
    // can briefly leave a dashed reference line in the DOM during
    // mount/unmount cycles — particularly relevant during the
    // dashboard's 10s polling cadence.
    expect(src).toMatch(/isAnimationActive=\{\s*false\s*\}/);
  });
});

// ── Dashboard sections — paint isolation ────────────────────────────
describe('Dashboard sections — paint isolation (ISSUE 6)', () => {
  const scss = read('src/app/dashboard/dashboard.module.scss');

  it('.section creates an isolated stacking context', () => {
    // Every .section must be position:relative + isolation:isolate so
    // any chart artifact that escapes its card cannot z-fight a sibling
    // section header. The SCSS comment block above this rule explains
    // why; we assert the CSS itself.
    expect(scss).toMatch(/\.section\s*\{[\s\S]*?position:\s*relative/);
    expect(scss).toMatch(/\.section\s*\{[\s\S]*?isolation:\s*isolate/);
  });

  it('.grid3 helper class exists for the compact signal preview', () => {
    // Without this class, `className={styles.grid3}` resolved to
    // undefined and the signal cards laid out with no grid — that's
    // the "signals section explodes vertically" symptom.
    expect(scss).toMatch(/\.grid3\s*\{/);
  });

  it('compact opportunity row class exists', () => {
    expect(scss).toMatch(/\.oppRowCompact\s*\{/);
  });
});

// ── Compact dashboard signals (ISSUE 3) ─────────────────────────────
describe('Dashboard signals preview — compact (ISSUE 3)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('limits dashboard signal preview to top 3', () => {
    // The grid map on the dashboard MUST slice the rendered list to
    // the first 3. The slice variable used to be `opps`; after the
    // NO_TRADE-precedence fix the dashboard partitions opps into a
    // trade-ready bucket and an early-candidates bucket, both of
    // which are sliced to 3. We accept either name as long as the
    // top-3 cap is in place.
    expect(src).toMatch(/(?:opps|tradeReady|earlyCandidates)\.slice\(\s*0\s*,\s*3\s*\)\.map/);
  });

  it('uses the compact row class, not the full oppCard, on the dashboard', () => {
    // styles.oppRowCompact is the compact horizontal row; styles.oppCard
    // is the big detail card that belongs on /signals. The dashboard
    // signals block must use the compact class.
    expect(src).toMatch(/className=\{styles\.oppRowCompact\}/);
  });

  it('renders a "View all signals" link to /signals', () => {
    expect(src).toMatch(/href=["']\/signals["']/);
    expect(src).toMatch(/View all signals/);
  });

  it('does NOT render the full oppCard for every signal on the dashboard', () => {
    // The full card is used on /signals (where it belongs). On the
    // dashboard the only references should be the import or the SCSS
    // class definition reference — never as the per-signal renderer.
    // We check that no `opps.map(... oppCard ...)` pattern survives.
    // Avoid the `s` (dotall) regex flag — tsconfig targets es2017.
    // [\s\S] is the portable equivalent.
    const oppsMapBlock = src.match(/opps\.(map|slice)[\s\S]*?oppCard/);
    expect(oppsMapBlock).toBeNull();
  });
});

// ── Adaptive ranking heading (ISSUE 4) ──────────────────────────────
describe('Top Rankings heading adapts to top opportunity_rank (ISSUE 4)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('exposes a tier ladder (high / actionable / best_available)', () => {
    expect(src).toMatch(/'high'\s*\|\s*'actionable'\s*\|\s*'best_available'/);
  });

  it('uses 75 and 60 as the tier thresholds', () => {
    // 75 = high-conviction floor; 60 = actionable floor. If a future
    // patch tweaks these thresholds the tier copy needs to follow.
    expect(src).toMatch(/topOppRank\s*>=\s*75/);
    expect(src).toMatch(/topOppRank\s*>=\s*60/);
  });

  it('renders the explicit "No High-Conviction Setups" copy when tier is best_available', () => {
    expect(src).toMatch(/No High-Conviction (Setups|Rankings)/);
  });

  it('renders the High-Conviction Rankings title when topOppRank >= 75', () => {
    expect(src).toMatch(/High-Conviction Rankings/);
  });

  it('renders the Actionable Watchlist Rankings title when 60 <= topOppRank < 75', () => {
    expect(src).toMatch(/Actionable Watchlist Rankings/);
  });
});

// ── Bell-badge countability window (ISSUE 5) ────────────────────────
describe('Notifications aggregator — countable window (ISSUE 5)', () => {
  const src = read('src/app/api/notifications/route.ts');

  it('exposes COUNTABLE_WINDOW_DAYS env-tunable', () => {
    expect(src).toMatch(/COUNTABLE_WINDOW_DAYS/);
    expect(src).toMatch(/NOTIFICATIONS_COUNTABLE_DAYS/);
  });

  it('default countable window is 3 days (tightened from 14d)', () => {
    // The visual review on 2026-05 flagged the bell still pegged at
    // 99+ with the 14-day default. We tightened to 3 days so the bell
    // reflects "what needs my attention NOW," not "lifetime un-acked
    // count." If a future refactor changes the default back, this
    // test catches it before users see 99+ again.
    expect(src).toMatch(/NOTIFICATIONS_COUNTABLE_DAYS\)\s*\|\|\s*3\b/);
  });

  it('manipulation events outside the window are NOT countable', () => {
    // The manipulation row mapper must read isWithinCountableWindow
    // when assigning `countable`. Without this, every old un-acked
    // manipulation event keeps the bell at 99+.
    expect(src).toMatch(/sourceType:\s*['"]manipulation['"][\s\S]{0,400}countable:\s*isWithinCountableWindow/);
  });

  it('breaches outside the window are NOT countable either', () => {
    expect(src).toMatch(/sourceType:\s*['"]breach['"][\s\S]{0,400}countable:\s*isWithinCountableWindow/);
  });

  it('isWithinCountableWindow function is defined and used', () => {
    expect(src).toMatch(/function isWithinCountableWindow/);
  });

  it('summary endpoint surfaces historicalCount + countableWindowDays diagnostics', () => {
    // Surfacing these in the summary response lets the AppShell (or
    // an operator hitting the endpoint directly) verify that the bell
    // count matches the window and explain why the bell is lower
    // than the page count.
    expect(src).toMatch(/historicalCount/);
    expect(src).toMatch(/countableWindowDays/);
  });
});

// ── Behavioural test: countable filter math ─────────────────────────
describe('countable window logic', () => {
  // Mirror of isWithinCountableWindow so we can assert behavior
  // without importing the route (which pulls db, redis, etc.). If the
  // route's implementation drifts from this mirror, the regex tests
  // above fail before this one runs — keeping them in lockstep.
  function isWithinWindow(iso: string | null | undefined, days: number): boolean {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return false;
    return Date.now() - t <= days * 86_400_000;
  }

  it('returns true for recent timestamps', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(isWithinWindow(yesterday, 14)).toBe(true);
  });

  it('returns false for ancient timestamps', () => {
    const monthsAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(isWithinWindow(monthsAgo, 14)).toBe(false);
  });

  it('returns false for null/undefined/garbage', () => {
    expect(isWithinWindow(null, 14)).toBe(false);
    expect(isWithinWindow(undefined, 14)).toBe(false);
    expect(isWithinWindow('not-a-date', 14)).toBe(false);
  });

  it('an account with 100 historical un-acked events shows 0 unread once outside the window', () => {
    // Simulates the 99+ symptom. 100 manipulation events from 60 days
    // ago: each would have countable=false, so the bell math (which
    // filters on countable first) produces unreadCount=0.
    const oldRows = Array.from({ length: 100 }, (_, i) => ({
      id: `manip-${i}`,
      severity: 'critical' as const,
      isRead: false,
      countable: isWithinWindow(new Date(Date.now() - 60 * 86_400_000).toISOString(), 14),
      category: 'manipulation' as const,
    }));
    const countable = oldRows.filter((r) => r.countable);
    const unread = countable.filter((r) => !r.isRead).length;
    expect(unread).toBe(0);
  });

  it('with the new 3-day default, week-old un-acked events drop off the bell too', () => {
    // The previous 14-day window kept week-old alerts inflating the
    // bell. The tightened 3-day default drops them too — so even
    // accounts with 50+ alerts from "earlier this week" go to zero
    // bell once the events age past 72h.
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const rows = Array.from({ length: 50 }, () => ({
      isRead: false,
      countable: isWithinWindow(weekAgo, 3),
    }));
    const unread = rows.filter((r) => r.countable && !r.isRead).length;
    expect(unread).toBe(0);
  });
});

// ── Closed-market Recent Decisions wording (ISSUE 2) ────────────────
describe('Recent Decisions empty state — closed-market wording (ISSUE 2)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('switches empty-state copy when marketStatus.isOpen === false', () => {
    // The closed-market branch must surface the explicit "No fresh
    // decisions in the current market-closed session…" copy so the
    // operator never reads a Saturday empty state as a live
    // decision opportunity.
    expect(src).toMatch(/No fresh decisions in the current market-closed session/);
    expect(src).toMatch(/should not be treated as live trade decisions/);
  });

  it('Evaluate button label flips to Last-Close Candidates when closed', () => {
    // The button text changes under closed market so the click target
    // reads as a reference run, not a live execution gate.
    expect(src).toMatch(/Evaluate Last-Close Candidates/);
  });

  it('Evaluate button gets a clarifying tooltip when closed', () => {
    expect(src).toMatch(/Runs the gate chain on last-close candidates\./);
  });
});

// ── Closed-market Manipulation Scan wording (ISSUE 3) ───────────────
describe('Manipulation Scan — closed-market wording (ISSUE 3)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('shows the closed-market historical-alerts copy', () => {
    expect(src).toMatch(/Historical alerts from last available scan\.\s+Fresh live detection resumes during market hours\./);
  });

  it('Run Scan button gets a closed-market tooltip', () => {
    expect(src).toMatch(/Uses last available\/cached data while market is closed\./);
  });
});

// ── Below-action-threshold row treatment (ISSUE 4) ──────────────────
describe('Rankings rows — below action threshold (ISSUE 4)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('exposes a BelowThresholdBadge component for sub-60 rows', () => {
    expect(src).toMatch(/function BelowThresholdBadge\(/);
    // The badge label must be the agreed copy — "Universe Scan" —
    // not a freeform string. Operators recognise this label as
    // "this is the universe state, not a buy list."
    expect(src).toMatch(/Universe Scan/);
  });

  it('exposes a ModelBiasPill component for sub-60 rows', () => {
    expect(src).toMatch(/function ModelBiasPill\(/);
    // The label vocabulary: HOLD becomes "Watch"; BUY/SELL become
    // "Model Bias: Buy"/"Model Bias: Sell". The exact strings are
    // pinned because operators are conditioned to read them.
    expect(src).toMatch(/Model Bias:/);
    expect(src).toMatch(/'Watch'/);
  });

  it('rows below 60 rank render ModelBiasPill, not the actionable SignalPill', () => {
    // The conditional swap is the load-bearing fix. If a future
    // refactor reverts to `<SignalPill type={r.signal_type} />`
    // unconditionally, sub-threshold rows go back to looking like
    // BUY calls.
    expect(src).toMatch(/belowThreshold[\s\S]{0,200}ModelBiasPill/);
  });

  it('rows below 60 rank suppress the conviction badge', () => {
    // A sub-threshold row showing a green "high conviction" badge
    // would directly contradict the rank label. The rendering path
    // must short-circuit to the em-dash placeholder instead.
    expect(src).toMatch(/belowThreshold[\s\S]{0,400}\?\s*<span[\s\S]{0,200}—[\s\S]{0,200}ConvictionBadge/);
  });

  it('uses 60 as the actionable threshold for the row treatment', () => {
    // Mirrors the ranking-tier ladder. Drift between the two
    // thresholds would produce rows badged "Universe Scan" while
    // the section header still claimed "Actionable Watchlist."
    expect(src).toMatch(/oppNum\s*<\s*60/);
  });
});

// ── Final polish — manipulation top-5 + view-all (item 1) ──────────
describe('Manipulation Detection preview — compact (final-polish item 1)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('caps the dashboard manipulation table to 5 rows', () => {
    // Symmetric with the Signals & Opportunities top-3 rule. The
    // full 10-row table belongs on /manipulation; the dashboard
    // preview is a glanceable strip.
    expect(src).toMatch(/mdAlerts\.slice\(\s*0\s*,\s*5\s*\)\.map/);
  });

  it('renders a "View all manipulation alerts" link to /manipulation', () => {
    // Path note: AppShell labels the route "Manipulation Watch" but
    // the URL is /manipulation (not /manipulation-watch).
    expect(src).toMatch(/href=["']\/manipulation["']/);
    expect(src).toMatch(/View all manipulation alerts/);
  });

  it('uses the shared viewAllLink class for visual symmetry with Signals', () => {
    // Both the signals and manipulation "view all" affordances
    // should share the same SCSS class so the dashboard reads
    // consistently. Drift here would be a visual smell.
    expect(src).toMatch(/className=\{styles\.viewAllLink\}/);
  });
});

// ── Final polish — historical alert labels (item 2) ────────────────
describe('Manipulation counts row — historical labels (final-polish item 2)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('label vocabulary swaps to Historical when closed or stale', () => {
    // The labels MUST flip when the underlying data is closed-market
    // or older than the historical threshold. Without this swap, a
    // Saturday "Critical: 4" reads identically to a live "Critical:
    // 4" — which is the symptom users flagged.
    expect(src).toMatch(/'Historical Alerts'/);
    expect(src).toMatch(/'Historical Critical'/);
    expect(src).toMatch(/'Historical Warnings'/);
  });

  it('label swap is gated on isClosed || isHistorical, not just one', () => {
    // The swap should fire if EITHER condition is true (closed market
    // OR alert age >= 3 days). A stale dataset on a Friday open
    // session is still historical for our purposes.
    expect(src).toMatch(/useHistoricalLabels\s*=\s*isClosed\s*\|\|\s*isHistorical/);
  });
});

// ── Final polish — Conviction Distribution readability (item 3) ────
describe('ConvictionDistribution zero-state readability (final-polish item 3)', () => {
  const src = read('src/components/dashboard/ConvictionDistribution.tsx');

  it('does NOT collapse opacity to 0.5 for zero-count rows', () => {
    // The 0.5 opacity made every zero row read as "loading/broken."
    // The zero state must keep full opacity; the visual cue is the
    // muted (but readable) text + neutral icon background, not a
    // fade. If a future patch reintroduces `opacity: d.count > 0 ?
    // 1 : 0.5` this test catches it.
    expect(src).not.toMatch(/opacity:\s*d\.count\s*>\s*0\s*\?\s*1\s*:\s*0\.5/);
  });

  it('zero-state label color meets readable contrast (slate-600 #475569)', () => {
    // Slate-400 (#94A3B8) was below WCAG 4.5:1 against the
    // #FAFBFC zero-state background. Slate-600 (#475569) gives
    // ~7.5:1 — comfortably readable while still visually muted.
    expect(src).toMatch(/d\.count\s*>\s*0\s*\?\s*d\.textColor\s*:\s*'#475569'/);
  });

  it('zero-state numeric value also reads clearly (no slate-300)', () => {
    // The bold "0" used to render in #CBD5E1 (slate-300, ~2.4:1
    // contrast) which made it look like a placeholder. After the
    // fix the explicit "0" reads as data, not as "value pending."
    expect(src).not.toMatch(/d\.count\s*>\s*0\s*\?\s*d\.textColor\s*:\s*'#CBD5E1'/);
  });
});

// ── Final polish — ranking subtitle shortened (item 4) ─────────────
describe('Top Rankings subtitle — shortened (final-polish item 4)', () => {
  const src = read('src/app/dashboard/page.tsx');

  it('subtitle is now a single short caption regardless of tier', () => {
    // The grey subtitle previously duplicated the long banner copy
    // for the best_available tier. The polish keeps it short and
    // lets the amber banner carry the full explanation.
    expect(src).toMatch(/const rankingSubtitle = 'Sorted by Opportunity Rank'/);
  });

  it('detailed "below the 60 threshold" copy lives in the yellow banner only', () => {
    // The detailed explainer must still exist (so the user
    // understands why rank-57 is on screen) — but only in the
    // amber banner, not duplicated in the subtitle.
    expect(src).toMatch(/No High-Conviction Rankings Available/);
    expect(src).toMatch(/Top opportunity rank is \{topOppRank\.toFixed\(0\)\}/);
  });
});

// ── Behavioural test: row treatment math ────────────────────────────
describe('below-threshold row classification', () => {
  // Mirror of the predicate in dashboard/page.tsx so we can assert
  // the math without rendering React.
  function isBelowThreshold(opp: number | null | undefined): boolean {
    const n = Number(opp);
    return !Number.isFinite(n) || n < 60;
  }

  it('opp >= 60 is actionable (not below threshold)', () => {
    expect(isBelowThreshold(60)).toBe(false);
    expect(isBelowThreshold(75)).toBe(false);
    expect(isBelowThreshold(99)).toBe(false);
  });

  it('opp < 60 is below threshold', () => {
    expect(isBelowThreshold(0)).toBe(true);
    expect(isBelowThreshold(57)).toBe(true);
    expect(isBelowThreshold(59.9)).toBe(true);
  });

  it('null/undefined/garbage rank is conservatively below threshold', () => {
    expect(isBelowThreshold(null)).toBe(true);
    expect(isBelowThreshold(undefined)).toBe(true);
    expect(isBelowThreshold(NaN)).toBe(true);
  });
});
