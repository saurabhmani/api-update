// ════════════════════════════════════════════════════════════════
//  GET /api/notifications — Alert Command Center aggregator
//  POST /api/notifications — mark single / all as read
//
//  Spec ALERT-CENTER §4 — the page used to read only the legacy
//  `notifications` table, which is empty in most environments. The
//  dashboard already exposes manipulation alerts, portfolio breaches,
//  market-condition warnings, etc., so the page rendered "All caught
//  up!" while a banner two screens up showed thousands of critical
//  alerts.
//
//  This route now MERGES every alert source into one normalized
//  NotificationItem feed:
//    1. q365_manipulation_events  → category='manipulation'
//    2. portfolio_breaches        → category='risk' / 'portfolio'
//    3. notifications (legacy)    → category from row.type
//    4. Synthetic system items derived from getMarketEnvelope()
//       (weekend banner, holiday banner, bypass-env warning).
//
//  Read state:
//    - Manipulation events are read-once until status='dismissed'.
//      The aggregator emits them as `isRead = status !== 'new'`.
//    - Breaches are read-once until acknowledged=1.
//    - Legacy `notifications` rows use is_read.
//    - System items synthesized from market state are always isRead=false
//      until the user explicitly dismisses them (id `sys-*`); we keep a
//      per-user dismiss table inline as a soft state.
//
//  POST contract (back-compat):
//    { id: 'manip-123' | 'breach-7' | 'notif-12' | 'sys-weekend' }
//    { all: true }                 — mark every item read
//
//  Spec §1 / §7 — the response embeds the central market envelope so
//  the UI can never label cached/last-close alerts as "live".
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';
import { getMarketEnvelope } from '@/lib/marketData/marketHours';
import type {
  NotificationCategory,
  NotificationDataSource,
  NotificationItem,
  NotificationSeverity,
} from '@/types';

/**
 * Internal extension of NotificationItem. The aggregator needs to know
 * whether each item should COUNT toward the bell's unread badge — the
 * informational "Market Closed (Weekend)" system item is read-state
 * `false` (so the page can offer a per-user dismiss) but must NOT
 * inflate the bell's unread count or trigger a red dot every weekend.
 *
 * `countable=false` items are still rendered on the page; they just
 * don't fire the badge. The wire payload strips this internal flag
 * before responding so the client `NotificationItem` shape stays clean.
 */
type AggregatedItem = NotificationItem & {
  /** Internal — does this row count toward unreadCount / criticalCount? */
  countable: boolean;
  /** Internal — used to look up per-user read state. */
  sourceType: string;
  sourceId:   string;
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Hard cap on aggregated feed size. Each source pulls up to
// PER_SOURCE_LIMIT rows; the merged feed is capped at MAX_FEED_SIZE.
//
// Bumped 2026-05 after operators reported the page rendering only
// the first 100 critical events when manipulation had ≥100 active
// rows. The page can render 2000 rows comfortably (no virtualization
// needed for that scale — stable keys + flat <Card> scroll work fine),
// and the SQL queries are bounded by the per-source filter so the
// 500-row limit per source is the practical institutional ceiling.
//
// Override either via env if a deployment hits a hot edge case:
//   NOTIFICATIONS_PER_SOURCE_LIMIT=1000 NOTIFICATIONS_MAX_FEED_SIZE=5000
const PER_SOURCE_LIMIT = Math.max(100, Number(process.env.NOTIFICATIONS_PER_SOURCE_LIMIT) || 500);
const MAX_FEED_SIZE    = Math.max(300, Number(process.env.NOTIFICATIONS_MAX_FEED_SIZE) || 2000);

// Bell-badge countability window. Manipulation events and breaches
// older than this remain VISIBLE on the Notifications page (so the
// audit trail is preserved) but stop contributing to the bell's
// unreadCount / criticalCount. Without this gate, an account with
// 100+ historical un-acked manipulation events from past months
// permanently shows "99+" on the bell — operators reported this as
// useless because the badge no longer signals actionable urgency.
//
// Tightened 2026-05 from 14 days → 3 days after the visual review
// flagged the bell still pegged at 99+. The previous 14-day window
// was set to "preserve recent context"; in practice operators were
// still drowning in un-actioned manipulation events from a week or
// two prior. Three days reflects the institutional intra-week
// trading horizon: what hasn't been triaged in 72h is operationally
// historical even if technically un-acked. The Notifications page
// still shows everything; only the bell badge tightens.
//
// Override via NOTIFICATIONS_COUNTABLE_DAYS=N for desks with
// different cadences.
const COUNTABLE_WINDOW_DAYS = Math.max(1, Number(process.env.NOTIFICATIONS_COUNTABLE_DAYS) || 3);
const COUNTABLE_WINDOW_MS   = COUNTABLE_WINDOW_DAYS * 86_400_000;


function isWithinCountableWindow(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= COUNTABLE_WINDOW_MS;
}

// ── Helpers ─────────────────────────────────────────────────────

/** Normalize the engine's manipulation severity vocabulary
 *  ('low'|'medium'|'high'|'severe') to the UI's
 *  ('info'|'warning'|'critical'|'success'). */
function manipulationSeverity(s: unknown): NotificationSeverity {
  const v = String(s ?? '').toLowerCase();
  if (v === 'severe' || v === 'high' || v === 'critical') return 'critical';
  if (v === 'medium' || v === 'warning') return 'warning';
  if (v === 'success') return 'success';
  return 'info';
}

/** Breach severity is already the UI vocabulary, just narrow it. */
function breachSeverity(s: unknown): NotificationSeverity {
  const v = String(s ?? '').toLowerCase();
  if (v === 'critical') return 'critical';
  if (v === 'warning')  return 'warning';
  if (v === 'success')  return 'success';
  return 'info';
}

function titleCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function safeIso(d: unknown): string {
  try {
    if (d instanceof Date) return d.toISOString();
    if (typeof d === 'string' && d) {
      const parsed = new Date(d);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
      return d;
    }
  } catch { /* fall through */ }
  return new Date().toISOString();
}

function safeJsonParse<T>(s: unknown): T | null {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** Severity rank for sort: critical (0) → warning (1) → info (2) → success (3). */
const SEV_RANK: Record<NotificationSeverity, number> = {
  critical: 0, warning: 1, info: 2, success: 3,
};

// ── Source: manipulation events ─────────────────────────────────

async function loadManipulationItems(): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, symbol, event_type, severity, score, status,
              event_date, evidence_json, created_at
         FROM q365_manipulation_events
        WHERE status NOT IN ('resolved', 'false_positive', 'dismissed')
        ORDER BY event_date DESC, score DESC
        LIMIT ?`,
      [PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      const evidence = safeJsonParse<{ reason?: string }>(r.evidence_json) ?? {};
      const symbol   = String(r.symbol ?? '').toUpperCase() || null;
      const type     = String(r.event_type ?? 'unknown');
      const createdAt = safeIso(r.created_at ?? r.event_date);
      // NOTE: isRead is now driven entirely by per-user read state.
      // The global manipulation status only flips via operational
      // workflow ('resolved', 'false_positive', 'dismissed'); a single
      // user marking the alert read no longer hides it for everyone.
      //
      // `countable` gates the bell badge — only events INSIDE the
      // countable window contribute to unreadCount/criticalCount.
      // Older un-acked events stay visible on the page (audit trail
      // intact) but cannot inflate the bell to 99+ from historical
      // backlog alone. ISSUE 5 fix.
      return {
        id:         `manip-${r.id}`,
        sourceType: 'manipulation',
        sourceId:   String(r.id),
        countable:  isWithinCountableWindow(createdAt),
        title:      `${titleCase(type)}${symbol ? ` on ${symbol}` : ''}`,
        message:    evidence.reason
          ? String(evidence.reason)
          : `${titleCase(type)} pattern detected (score ${Math.round(Number(r.score) * 100) / 100}).`,
        severity:   manipulationSeverity(r.severity),
        category:   'manipulation' as NotificationCategory,
        symbol,
        exchange:   null,
        source:     'manipulation_engine',
        isRead:     false,  // per-user overlay applied later
        createdAt,
        actionUrl:  symbol ? `/manipulation?symbol=${encodeURIComponent(symbol)}` : '/manipulation',
      } satisfies AggregatedItem;
    });
  } catch (err) {
    console.warn('[/api/notifications] manipulation source failed:', (err as Error)?.message);
    return [];
  }
}

// ── Source: portfolio breaches ──────────────────────────────────

async function loadBreachItems(portfolioId: number | null): Promise<AggregatedItem[]> {
  if (portfolioId == null) return [];
  try {
    const { rows } = await db.query<any>(
      `SELECT id, portfolio_id, category, severity, metric,
              current_value, threshold, message, source,
              detected_at, acknowledged
         FROM portfolio_breaches
        WHERE portfolio_id = ?
          AND acknowledged = 0
        ORDER BY FIELD(severity, 'critical', 'warning', 'info'),
                 detected_at DESC
        LIMIT ?`,
      [portfolioId, PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      const cat = String(r.category ?? 'risk_breach').toLowerCase();
      const mappedCategory: NotificationCategory =
        cat.startsWith('concentration') || cat === 'portfolio_drift' ? 'portfolio'
        : cat === 'governance_warning' || cat === 'stale_data_warning' ? 'system'
        : cat === 'signal_alert' ? 'signal'
        : 'risk';
      const symbol = (() => {
        const m = String(r.metric ?? '').toUpperCase().match(/SYMBOL[:_=]?([A-Z0-9._-]+)/);
        return m ? m[1] : null;
      })();
      const detectedAt = safeIso(r.detected_at);
      return {
        id:         `breach-${r.id}`,
        sourceType: 'breach',
        sourceId:   String(r.id),
        // Breaches inside the countable window drive the bell. Stale
        // un-acked breaches remain visible on the page so the audit
        // trail isn't lost, but they don't permanently inflate the
        // badge to 99+. ISSUE 5 fix.
        countable:  isWithinCountableWindow(detectedAt),
        title:      titleCase(String(r.category ?? 'risk_breach').replace(/_/g, ' ')),
        message:    String(r.message ?? `${r.metric} ${r.current_value} / ${r.threshold}`),
        severity:   breachSeverity(r.severity),
        category:   mappedCategory,
        symbol,
        exchange:   null,
        source:     String(r.source ?? 'breachDetection'),
        // breaches still carry their own acknowledged flag, so a breach
        // marked acknowledged is read for everyone (operational
        // workflow). The per-user overlay is layered on top later.
        isRead:     Boolean(r.acknowledged),
        createdAt:  detectedAt,
        actionUrl:  mappedCategory === 'portfolio' ? '/portfolio'
                   : mappedCategory === 'signal' ? '/signals'
                   : '/risk',
      } satisfies AggregatedItem;
    });
  } catch (err) {
    console.warn('[/api/notifications] breaches source failed:', (err as Error)?.message);
    return [];
  }
}

// ── Source: legacy persisted notifications table ────────────────

async function loadLegacyNotificationItems(userId: number): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, message, type, is_read, created_at
         FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [userId, PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      // Map free-form `type` strings to our category union. Defaults
      // to 'system' for anything we don't recognise so nothing is lost.
      const t = String(r.type ?? '').toLowerCase();
      const category: NotificationCategory =
          t.includes('signal')      ? 'signal'
        : t.includes('rank')        ? 'ranking'
        : t.includes('manip')       ? 'manipulation'
        : t.includes('risk')        ? 'risk'
        : t.includes('watch')       ? 'watchlist'
        : t.includes('portfolio')   ? 'portfolio'
        : t.includes('market')      ? 'market_status'
        : 'system';
      const severity: NotificationSeverity =
          t.includes('critical') ? 'critical'
        : t.includes('warning')  ? 'warning'
        : t.includes('success')  ? 'success'
        : 'info';
      return {
        id:         `notif-${r.id}`,
        sourceType: 'notif',
        sourceId:   String(r.id),
        countable:  true,
        title:      titleCase(t || 'Notification'),
        message:    String(r.message ?? ''),
        severity,
        category,
        symbol:     null,
        exchange:   null,
        source:     'notifications',
        isRead:     Boolean(r.is_read),
        createdAt:  safeIso(r.created_at),
        actionUrl:  null,
      } satisfies AggregatedItem;
    });
  } catch (err) {
    console.warn('[/api/notifications] legacy source failed:', (err as Error)?.message);
    return [];
  }
}

// ── Source: high-confidence q365 signals + status changes ──────
//
// Surfaces newly approved high-conviction signals and signals that
// flipped to invalidated/expired/stopped/target-hit status. Wrapped in
// safe try/catch — if `q365_signals` is missing or differently shaped
// in this deployment, the source returns [] and the rest of the feed
// still loads. Uses a 24h window so the bell isn't spammed by ancient
// signals on first load.
async function loadSignalItems(): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, instrument_key, direction, status, confidence_score,
              confidence_band, classification, generated_at, updated_at,
              invalidation_reason
         FROM q365_signals
        WHERE (status IN ('active','flagged','invalidated','expired','stopped','target_hit')
               AND COALESCE(updated_at, generated_at) > (NOW() - INTERVAL 24 HOUR))
           OR (status IN ('active','flagged')
               AND confidence_score >= 80
               AND generated_at      > (NOW() - INTERVAL 6 HOUR))
        ORDER BY COALESCE(updated_at, generated_at) DESC
        LIMIT ?`,
      [PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      const sym = String(r.instrument_key ?? '').replace(/^.*\|/, '').toUpperCase() || null;
      const direction = String(r.direction ?? 'BUY').toUpperCase();
      const status    = String(r.status ?? '').toLowerCase();
      const conf      = Number(r.confidence_score) || 0;

      // Status-change rows get a critical/warning severity so they
      // surface above routine high-confidence picks.
      const isStatusChange = ['invalidated','expired','stopped','target_hit'].includes(status);
      const severity: NotificationSeverity =
        status === 'invalidated' || status === 'stopped' ? 'critical'
        : status === 'expired' ? 'warning'
        : status === 'target_hit' ? 'success'
        : conf >= 85 ? 'critical'
        : conf >= 75 ? 'warning'
        : 'info';

      const title = isStatusChange
        ? `Signal ${status.replace('_',' ')}${sym ? ` — ${sym}` : ''}`
        : `${direction} signal${sym ? ` — ${sym}` : ''} (${conf.toFixed(0)}% conf)`;
      const message = r.invalidation_reason
        ? String(r.invalidation_reason)
        : `${String(r.classification ?? '').replace(/_/g,' ')} · band ${r.confidence_band ?? '—'}`;

      return {
        id:         `signal-${r.id}`,
        sourceType: 'signal',
        sourceId:   String(r.id),
        countable:  true,
        title,
        message,
        severity,
        category:   'signal' as NotificationCategory,
        symbol:     sym,
        exchange:   null,
        source:     'q365_signals',
        isRead:     false,
        createdAt:  safeIso(r.updated_at ?? r.generated_at),
        actionUrl:  sym ? `/signals?symbol=${encodeURIComponent(sym)}` : '/signals',
      } satisfies AggregatedItem;
    });
  } catch (err) {
    // Expected if q365_signals isn't present in this environment.
    return [];
  }
}

// ── Source: ranking changes (top movers in / out of top tier) ──
//
// Best-effort. Looks for symbols whose rank moved meaningfully since
// the last snapshot. If `rankings_history` doesn't exist (older
// installs), returns []. We do NOT synthesize from live data here —
// the route's role is to read existing alert sources, not generate.
async function loadRankingChangeItems(): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, tradingsymbol, prev_rank, new_rank, change_magnitude,
              detected_at
         FROM rankings_history
        WHERE detected_at > (NOW() - INTERVAL 24 HOUR)
          AND ABS(change_magnitude) >= 10
        ORDER BY detected_at DESC
        LIMIT ?`,
      [PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      const sym  = String(r.tradingsymbol ?? '').toUpperCase() || null;
      const mag  = Number(r.change_magnitude) || 0;
      const dir  = mag > 0 ? 'up' : 'down';
      return {
        id:         `ranking-${r.id}`,
        sourceType: 'ranking',
        sourceId:   String(r.id),
        countable:  true,
        title:      `${sym ?? 'Stock'} moved ${dir} ${Math.abs(mag).toFixed(0)} ranks`,
        message:    `Rank ${r.prev_rank ?? '—'} → ${r.new_rank ?? '—'}`,
        severity:   Math.abs(mag) >= 25 ? 'warning' : 'info',
        category:   'ranking' as NotificationCategory,
        symbol:     sym,
        exchange:   null,
        source:     'rankings_history',
        isRead:     false,
        createdAt:  safeIso(r.detected_at),
        actionUrl:  '/rankings',
      } satisfies AggregatedItem;
    });
  } catch {
    return [];
  }
}

// ── Source: watchlist alerts (legacy `alerts` table, triggered) ──
async function loadWatchlistItems(userId: number): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, instrument_key, tradingsymbol, condition_type,
              target_price, triggered_at
         FROM alerts
        WHERE user_id = ?
          AND triggered_at IS NOT NULL
          AND triggered_at > (NOW() - INTERVAL 24 HOUR)
        ORDER BY triggered_at DESC
        LIMIT ?`,
      [userId, PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => {
      const sym = String(r.tradingsymbol ?? '').toUpperCase() || null;
      return {
        id:         `watchlist-${r.id}`,
        sourceType: 'watchlist',
        sourceId:   String(r.id),
        countable:  true,
        title:      `${sym ?? 'Watchlist'} hit ${r.condition_type} ${r.target_price}`,
        message:    `Price alert triggered`,
        severity:   'warning',
        category:   'watchlist' as NotificationCategory,
        symbol:     sym,
        exchange:   null,
        source:     'alerts',
        isRead:     false,
        createdAt:  safeIso(r.triggered_at),
        actionUrl:  sym ? `/watchlist` : '/watchlist',
      } satisfies AggregatedItem;
    });
  } catch {
    return [];
  }
}

// ── Source: high-volatility / weak-market warnings ──────────────
//
// Reads from `market_intelligence_snapshots` if available. Surfaces
// volatility spikes and weak-market regimes as actionable warnings.
async function loadMarketConditionItems(): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, snapshot_type, severity, message, detected_at
         FROM market_condition_warnings
        WHERE detected_at > (NOW() - INTERVAL 12 HOUR)
        ORDER BY detected_at DESC
        LIMIT ?`,
      [PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => ({
      id:         `volatility-${r.id}`,
      sourceType: 'volatility',
      sourceId:   String(r.id),
      countable:  true,
      title:      titleCase(String(r.snapshot_type ?? 'market_condition')),
      message:    String(r.message ?? '—'),
      severity:   breachSeverity(r.severity),
      category:   'system' as NotificationCategory,
      symbol:     null,
      exchange:   null,
      source:     'market_condition_warnings',
      isRead:     false,
      createdAt:  safeIso(r.detected_at),
      actionUrl:  '/dashboard',
    } satisfies AggregatedItem));
  } catch {
    return [];
  }
}

// ── Source: data-source / API failure / stale-data warnings ─────
async function loadDataQualityItems(): Promise<AggregatedItem[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT id, source_name, severity, message, detected_at, resolved_at
         FROM data_quality_warnings
        WHERE resolved_at IS NULL
          AND detected_at > (NOW() - INTERVAL 24 HOUR)
        ORDER BY detected_at DESC
        LIMIT ?`,
      [PER_SOURCE_LIMIT],
    );
    return (rows as any[]).map((r) => ({
      id:         `data_quality-${r.id}`,
      sourceType: 'data_quality',
      sourceId:   String(r.id),
      countable:  true,
      title:      `Data source warning: ${r.source_name ?? 'unknown'}`,
      message:    String(r.message ?? '—'),
      severity:   breachSeverity(r.severity),
      category:   'system' as NotificationCategory,
      symbol:     null,
      exchange:   null,
      source:     'data_quality_warnings',
      isRead:     false,
      createdAt:  safeIso(r.detected_at),
      actionUrl:  '/admin/data',
    } satisfies AggregatedItem));
  } catch {
    return [];
  }
}

// ── Source: synthesized market/system items ─────────────────────
//
// These are derived purely from getMarketEnvelope(). They surface
// "Market Closed", holiday, and bypass-env warnings without needing
// a DB row. ID is stable per-day (`sys-weekend-2026-05-02`) so the
// mark-read store can deduplicate across page refreshes.

function loadSystemItems(): AggregatedItem[] {
  const env  = getMarketEnvelope();
  const now  = new Date().toISOString();
  const day  = env.nowIst.slice(0, 10); // YYYY-MM-DD in IST
  const items: AggregatedItem[] = [];

  if (env.bypassActive) {
    // Bypass-env warning IS actionable — operators should investigate.
    items.push({
      id:         `sys-bypass-${day}`,
      sourceType: 'sys',
      sourceId:   `bypass-${day}`,
      countable:  true,
      title:      'Market hours bypass is ACTIVE',
      message:    `${env.bypassReason ?? 'A bypass env is set'} — UI labels still follow the wall clock, but operators should be aware.`,
      severity:   'critical',
      category:   'system',
      isRead:     false,
      createdAt:  now,
      source:     'marketHours',
      actionUrl:  null,
    });
  }

  if (!env.isOpen) {
    // The closed-market info card MUST appear on the page so users
    // see why intel is labeled "last close", but it MUST NOT count
    // toward the bell badge — otherwise every weekend gets a red dot
    // even when there are zero actionable alerts. countable=false
    // excludes this row from unreadCount / criticalCount, while still
    // letting the user dismiss it on the Notifications page if they
    // want to clear the visible card.
    items.push({
      id:         `sys-${env.mode}-${day}`,
      sourceType: 'sys',
      sourceId:   `${env.mode}-${day}`,
      countable:  false,
      title:      env.label,
      message:    env.reason
        ? `${env.label}. ${env.reason}. Showing last available alerts and last-close intelligence.`
        : `${env.label}. Showing last available alerts and last-close intelligence.`,
      severity:   'info',
      category:   'market_status',
      isRead:     false,
      createdAt:  now,
      source:     'marketHours',
      actionUrl:  '/dashboard',
    });
  }

  return items;
}

// ── Per-user read state (DB-backed) ─────────────────────────────
//
// Replaces the previous in-memory dismissedSystemItems Map and the
// global mutation of q365_manipulation_events.status. Now ALL alert
// types support per-user read state via the user_notification_reads
// table (created in src/lib/db/migrate.ts). One user marking a
// manipulation alert read no longer hides it for everyone else.
//
// Operational status changes ('resolved', 'false_positive',
// 'dismissed') still belong on the source row — those are the
// workflow states, not personal read state.

type ReadKey = `${string}::${string}`;
function readKey(sourceType: string, sourceId: string): ReadKey {
  return `${sourceType}::${sourceId}`;
}

async function loadUserReadSet(userId: number): Promise<Set<ReadKey>> {
  try {
    const { rows } = await db.query<any>(
      `SELECT source_type, source_id FROM user_notification_reads WHERE user_id = ?`,
      [userId],
    );
    const out = new Set<ReadKey>();
    for (const r of rows as any[]) {
      out.add(readKey(String(r.source_type), String(r.source_id)));
    }
    return out;
  } catch {
    // Table missing (pre-migration deployment) — treat as empty so the
    // page still renders. The next migrate run will create it.
    return new Set();
  }
}

async function recordUserRead(
  userId: number, sourceType: string, sourceId: string,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO user_notification_reads (user_id, source_type, source_id, read_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE read_at = NOW()`,
      [userId, sourceType, sourceId],
    );
  } catch (err) {
    console.warn('[/api/notifications] recordUserRead failed:', (err as Error)?.message);
  }
}

async function recordUserReadBulk(
  userId: number,
  pairs: Array<{ sourceType: string; sourceId: string }>,
): Promise<void> {
  if (!pairs.length) return;
  try {
    const placeholders = pairs.map(() => '(?, ?, ?, NOW())').join(', ');
    const params: (string|number)[] = [];
    for (const p of pairs) {
      params.push(userId, p.sourceType, p.sourceId);
    }
    await db.query(
      `INSERT INTO user_notification_reads (user_id, source_type, source_id, read_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE read_at = NOW()`,
      params,
    );
  } catch (err) {
    console.warn('[/api/notifications] recordUserReadBulk failed:', (err as Error)?.message);
  }
}

// ── GET: aggregated feed ────────────────────────────────────────

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const market = getMarketEnvelope();
  const mode   = market.mode;
  const isSummary = req.nextUrl.searchParams.get('summary') === '1';

  // Optional ?portfolioId= override; falls back to the user's default
  // portfolio. resolveUserPortfolioId tolerates a missing portfolio.
  const portfolioId = await resolveUserPortfolioId(
    user.id,
    req.nextUrl.searchParams.get('portfolioId'),
  ).catch(() => null);

  // Run every source in parallel — independent queries, no shared
  // state. A single source failure logs and returns [] so the feed
  // never goes blank just because one table is missing. Each new
  // source is wrapped in its own try/catch so a missing table just
  // contributes 0 to counts_by_source.
  const [manip, breaches, legacy, signals, rankingChanges, watchlist, marketCond, dataQuality] =
    await Promise.all([
      loadManipulationItems(),
      loadBreachItems(portfolioId ?? null),
      loadLegacyNotificationItems(user.id),
      loadSignalItems(),
      loadRankingChangeItems(),
      loadWatchlistItems(user.id),
      loadMarketConditionItems(),
      loadDataQualityItems(),
    ]);
  const system  = loadSystemItems();
  const userReads = await loadUserReadSet(user.id);

  // Merge + dedupe + apply per-user read overlay. Marking an item read
  // is now per-user, so the same global manipulation row can show
  // unread for user A and read for user B — which is the entire point
  // of the fix.
  const seen = new Set<string>();
  const merged: AggregatedItem[] = [];
  for (const arr of [system, manip, breaches, legacy, signals, rankingChanges, watchlist, marketCond, dataQuality]) {
    for (const item of arr) {
      if (!item.id || seen.has(item.id)) continue;
      seen.add(item.id);
      const isReadForUser = userReads.has(readKey(item.sourceType, item.sourceId));
      merged.push({
        ...item,
        isRead: item.isRead || isReadForUser,
      });
    }
  }

  // Sort: critical first, then warnings, then info; newest first
  // within each severity bucket.
  merged.sort((a, b) => {
    const sev = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    if (sev !== 0) return sev;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  const aggregated = merged.slice(0, MAX_FEED_SIZE);

  // ── Honest counters ───────────────────────────────────────────
  // Only countable items contribute to bell-driving counters. The
  // non-countable Market-Closed/Weekend item is still on the page
  // (visible in `data`) but does NOT trigger the red dot. This is the
  // fix for ISSUE 8 — operators were getting a red bell every weekend
  // because the synthetic system info card was being treated as an
  // unread notification.
  const countable = aggregated.filter((n) => n.countable);
  const unreadCount   = countable.filter((n) => !n.isRead).length;
  const criticalCount = countable.filter((n) => n.severity === 'critical' && !n.isRead).length;
  const warningCount  = countable.filter((n) => n.severity === 'warning'  && !n.isRead).length;
  const systemCount   = aggregated.filter((n) => n.category === 'system' || n.category === 'market_status').length;

  // Diagnostic counts — surfaced in the response so operators can
  // verify the bell math. `historicalCount` is everything that
  // landed in the feed but was deemed too stale to drive the bell
  // (older than COUNTABLE_WINDOW_DAYS). The page lists every row
  // regardless; the bell badge is gated on `unreadCount`.
  const historicalCount = aggregated.filter((n) => !n.countable && !n.isRead).length;

  // Spec §4 — data_source mirrors the rest of the platform: 'live'
  // when the market is open and at least one source is fresh; otherwise
  // labeled honestly so the UI can't render LIVE on closed-market data.
  const data_source: NotificationDataSource =
    market.isOpen ? 'live'
    : market.state === 'pre-open' ? 'cached'
    : 'last_close';

  // counts_by_source diagnostic — surfaces every attempted source so
  // operators verifying the Alert Command Center wiring can see at a
  // glance which feeds are populated. Missing tables show as 0.
  const counts_by_source = {
    manipulation:  manip.length,
    breaches:      breaches.length,
    legacy:        legacy.length,
    signals:       signals.length,
    rankings:      rankingChanges.length,
    watchlist:     watchlist.length,
    market_condition: marketCond.length,
    data_quality:  dataQuality.length,
    system:        system.length,
  };

  // ── Summary mode (cheap; for the AppShell bell) ───────────────
  // The AppShell bell only needs counts. Returning the full data
  // payload to a header polling at 20s would waste bytes; summary
  // mode lets the bell poll `/api/notifications?summary=1` and the
  // page poll the unfiltered route.
  if (isSummary) {
    return NextResponse.json(
      {
        unreadCount,
        criticalCount,
        warningCount,
        systemCount,
        // historicalCount = un-acked-but-stale items. Surfaced so the
        // bell consumer (AppShell) can render an honest "+N historical"
        // sub-tooltip if it ever wants to, and so operators can verify
        // why the bell badge is lower than the page count.
        historicalCount,
        countableWindowDays: COUNTABLE_WINDOW_DAYS,
        marketStatus: {
          mode,
          isOpen:       market.isOpen,
          state:        market.state,
          bypassActive: market.bypassActive,
        },
        mode,
        as_of: new Date().toISOString(),
        counts_by_source,
      },
      {
        status:  200,
        headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
      },
    );
  }

  // ── Strip internal fields before responding ───────────────────
  // Keep the wire shape stable: `countable`, `sourceType`, `sourceId`
  // are aggregator internals, not part of the public NotificationItem.
  const data: NotificationItem[] = aggregated.map(({ countable: _c, sourceType: _t, sourceId: _i, ...rest }) => rest);

  return NextResponse.json(
    {
      data,
      unreadCount,
      criticalCount,
      warningCount,
      systemCount,
      historicalCount,
      countableWindowDays: COUNTABLE_WINDOW_DAYS,
      // Back-compat: old client reads `notifications` and `unread`.
      notifications: data,
      unread:        unreadCount,
      // Spec §1 — embed the full envelope so the page can render the
      // closed-market banner without a second round-trip.
      marketStatus: {
        mode,
        isOpen:          market.isOpen,
        state:           market.state,
        label:           market.label,
        nowIst:          market.nowIst,
        sessionOpenIst:  market.sessionOpenIst,
        sessionCloseIst: market.sessionCloseIst,
        isHoliday:       market.isHoliday,
        reason:          market.reason,
        bypassActive:    market.bypassActive,
        bypassReason:    market.bypassReason,
      },
      mode,
      data_source,
      as_of: new Date().toISOString(),
      counts_by_source,
    },
    {
      status:  200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}

// ── POST: mark read ─────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const compositeId: string | undefined = body?.id ? String(body.id) : undefined;
  const all: boolean = body?.all === true;

  // Helper — split a composite id like "manip-123" or "data_quality-7"
  // into (sourceType, sourceId). Uses the LAST hyphen as the boundary
  // so multi-segment source types stay intact.
  function splitCompositeId(id: string): { sourceType: string; sourceId: string } {
    const idx = id.lastIndexOf('-');
    if (idx < 0) return { sourceType: id, sourceId: '' };
    return { sourceType: id.slice(0, idx), sourceId: id.slice(idx + 1) };
  }

  // Map composite-id prefix → user_notification_reads.source_type.
  // The aggregator emits `manip-123` / `breach-7` etc., but the read
  // table uses the canonical sourceType ('manipulation' / 'breach').
  const COMPOSITE_PREFIX_TO_SOURCE_TYPE: Record<string, string> = {
    manip:        'manipulation',
    breach:       'breach',
    notif:        'notif',
    sys:          'sys',
    signal:       'signal',
    ranking:      'ranking',
    watchlist:    'watchlist',
    volatility:   'volatility',
    data_quality: 'data_quality',
  };

  // Mark-all path — record per-user read state for every visible
  // composite id. We fetch the live aggregated feed (cheap, this is
  // the same code the GET path runs) and write a row per item so
  // that going forward they stay read for THIS user only.
  if (all) {
    const portfolioId = await resolveUserPortfolioId(user.id, null).catch(() => null);
    const [manip, breaches, legacy, signals, rankingChanges, watchlist, marketCond, dataQuality] =
      await Promise.all([
        loadManipulationItems(),
        loadBreachItems(portfolioId ?? null),
        loadLegacyNotificationItems(user.id),
        loadSignalItems(),
        loadRankingChangeItems(),
        loadWatchlistItems(user.id),
        loadMarketConditionItems(),
        loadDataQualityItems(),
      ]);
    const system = loadSystemItems();

    const pairs: Array<{ sourceType: string; sourceId: string }> = [];
    for (const arr of [system, manip, breaches, legacy, signals, rankingChanges, watchlist, marketCond, dataQuality]) {
      for (const item of arr) {
        pairs.push({ sourceType: item.sourceType, sourceId: item.sourceId });
      }
    }
    await recordUserReadBulk(user.id, pairs);

    // Legacy `notifications` table still carries an is_read flag the
    // user owns directly — keep flipping it so non-aggregator readers
    // (e.g. an admin tool) see consistent state.
    try {
      await db.query(
        `UPDATE notifications SET is_read = TRUE WHERE user_id = ?`,
        [user.id],
      );
    } catch { /* tolerated */ }

    // We deliberately DO NOT mutate q365_manipulation_events.status or
    // portfolio_breaches.acknowledged from the personal mark-read
    // path. Those are operational workflow states; flipping them when
    // a single user clicks "mark all read" used to hide alerts for
    // everyone in the org. Resolve / dismiss / acknowledge live on the
    // dedicated workflow routes (e.g. /manipulation, /risk).

    return NextResponse.json({ success: true, marked: pairs.length });
  }

  // Single-id path — route by prefix and record per-user read state.
  if (!compositeId) {
    return NextResponse.json(
      { error: 'id or all=true required' },
      { status: 400 },
    );
  }

  const { sourceType: rawPrefix, sourceId } = splitCompositeId(compositeId);
  const sourceType = COMPOSITE_PREFIX_TO_SOURCE_TYPE[rawPrefix] ?? rawPrefix;

  try {
    // Always record per-user read so a future GET applies the overlay.
    await recordUserRead(user.id, sourceType, sourceId);

    // For the legacy notifications table specifically, the row carries
    // a per-user is_read flag we should also flip — both the aggregator
    // and the legacy /api/notifications-list reader see the same truth.
    if (sourceType === 'notif') {
      const numericId = parseInt(sourceId, 10);
      if (Number.isFinite(numericId)) {
        await db.query(
          `UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?`,
          [numericId, user.id],
        );
      }
    }
    return NextResponse.json({ success: true, id: compositeId });
  } catch (err) {
    return NextResponse.json(
      { error: 'mark-read failed', details: (err as Error)?.message },
      { status: 500 },
    );
  }
}
