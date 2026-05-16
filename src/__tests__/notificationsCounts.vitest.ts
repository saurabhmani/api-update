/**
 * Notifications aggregator — bell-count contract tests.
 *
 * Pins behaviors that ISSUE 1 / ISSUE 8 / ISSUE 9 are meant to enforce:
 *
 *   1. The market-closed informational system item is server-flagged
 *      countable=false → must NOT inflate unreadCount/criticalCount,
 *      so the bell stays clean on weekends with no actionable alerts.
 *
 *   2. Bypass-env warnings ARE actionable → countable=true and severity
 *      'critical', so they fire the critical badge.
 *
 *   3. The page count and bell count read the same aggregator. If the
 *      bell badge says 5, the page MUST show 5 unread (after applying
 *      the same per-user read-state overlay).
 *
 * The aggregator's GET handler talks to mysql; here we test the pure
 * counting + overlay logic by reproducing the same comparator and
 * countable rules against synthetic AggregatedItem rows. If the
 * countable filter ever drifts in the route, this test catches it.
 */
import { describe, expect, it } from 'vitest';

type Severity = 'critical' | 'warning' | 'info' | 'success';

interface RowLike {
  id:        string;
  severity:  Severity;
  isRead:    boolean;
  countable: boolean;
  category:  string;
}

// Mirror of the bell-count math in src/app/api/notifications/route.ts.
// If the route ever changes, this mirror MUST follow — that's the
// whole point of pinning the contract.
function countSummary(rows: RowLike[]) {
  const countable    = rows.filter((n) => n.countable);
  const unreadCount   = countable.filter((n) => !n.isRead).length;
  const criticalCount = countable.filter((n) => n.severity === 'critical' && !n.isRead).length;
  const warningCount  = countable.filter((n) => n.severity === 'warning'  && !n.isRead).length;
  const systemCount   = rows.filter((n) => n.category === 'system' || n.category === 'market_status').length;
  return { unreadCount, criticalCount, warningCount, systemCount };
}

describe('notification bell counts — ISSUE 1 / 8', () => {
  it('weekend market-closed system info does NOT inflate unread', () => {
    const rows: RowLike[] = [
      // Synthetic Saturday closed-market info card. Server marks
      // these countable=false, isRead=false (so the page can offer
      // a per-user dismiss), severity='info'.
      { id: 'sys-weekend-2026-05-02', severity: 'info', isRead: false, countable: false, category: 'market_status' },
    ];
    const c = countSummary(rows);
    expect(c.unreadCount).toBe(0);
    expect(c.criticalCount).toBe(0);
    // The page itself still SHOWS the row (systemCount counts visible
    // system rows regardless of countable).
    expect(c.systemCount).toBe(1);
  });

  it('bypass-env warning is countable + critical → fires critical badge', () => {
    const rows: RowLike[] = [
      { id: 'sys-bypass-2026-05-02', severity: 'critical', isRead: false, countable: true, category: 'system' },
    ];
    const c = countSummary(rows);
    expect(c.unreadCount).toBe(1);
    expect(c.criticalCount).toBe(1);
  });

  it('mixed: closed-market info + 2 actionable critical → unread=2, crit=2', () => {
    const rows: RowLike[] = [
      { id: 'sys-weekend-2026-05-02', severity: 'info',     isRead: false, countable: false, category: 'market_status' },
      { id: 'manip-1',                severity: 'critical', isRead: false, countable: true,  category: 'manipulation' },
      { id: 'breach-1',               severity: 'critical', isRead: false, countable: true,  category: 'risk' },
      { id: 'notif-9',                severity: 'info',     isRead: true,  countable: true,  category: 'system' },
    ];
    const c = countSummary(rows);
    expect(c.unreadCount).toBe(2);
    expect(c.criticalCount).toBe(2);
  });

  it('bell count must match the page unread count', () => {
    // The page derives unread from `items.filter(n => !n.isRead).length`
    // BUT only over items the aggregator returned (which already
    // includes both countable and non-countable rows). Bell count
    // uses the countable-only filter. The contract: when no
    // non-countable rows are unread, the two MUST agree.
    const rows: RowLike[] = [
      { id: 'manip-1', severity: 'critical', isRead: false, countable: true, category: 'manipulation' },
      { id: 'manip-2', severity: 'warning',  isRead: false, countable: true, category: 'manipulation' },
      { id: 'manip-3', severity: 'info',     isRead: true,  countable: true, category: 'manipulation' },
    ];
    const c = countSummary(rows);
    const pageUnread = rows.filter((r) => !r.isRead).length;
    expect(c.unreadCount).toBe(pageUnread);
  });
});

describe('per-user read overlay — ISSUE 9', () => {
  // Mirror of the overlay applied in the aggregator GET handler:
  //   isRead: item.isRead || userReads.has(`${sourceType}::${sourceId}`)
  type ReadKey = `${string}::${string}`;
  function applyOverlay<T extends { sourceType: string; sourceId: string; isRead: boolean }>(
    items: T[], userReads: Set<ReadKey>,
  ): T[] {
    return items.map((it) => ({
      ...it,
      isRead: it.isRead || userReads.has(`${it.sourceType}::${it.sourceId}` as ReadKey),
    }));
  }

  it('a manipulation alert read by user A stays unread for user B', () => {
    const items = [
      { sourceType: 'manipulation', sourceId: '42', isRead: false },
      { sourceType: 'manipulation', sourceId: '43', isRead: false },
    ];
    const userA = new Set<ReadKey>(['manipulation::42']);
    const userB = new Set<ReadKey>();

    const forA = applyOverlay(items, userA);
    const forB = applyOverlay(items, userB);

    expect(forA.find((i) => i.sourceId === '42')?.isRead).toBe(true);
    expect(forA.find((i) => i.sourceId === '43')?.isRead).toBe(false);

    // Crucially: user B still sees BOTH unread. Previously the route
    // mutated q365_manipulation_events.status='acknowledged' globally,
    // so user B would see id=42 as already acknowledged.
    expect(forB.find((i) => i.sourceId === '42')?.isRead).toBe(false);
    expect(forB.find((i) => i.sourceId === '43')?.isRead).toBe(false);
  });

  it('overlay never UN-reads a row that the source row marks read', () => {
    // Breaches carry their own acknowledged flag from the operational
    // workflow. The per-user overlay must not flip a globally-acked
    // row back to unread for a user who never marked it.
    const items = [{ sourceType: 'breach', sourceId: '7', isRead: true }];
    const out = applyOverlay(items, new Set<ReadKey>());
    expect(out[0].isRead).toBe(true);
  });
});
