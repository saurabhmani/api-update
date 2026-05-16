'use client';
// ════════════════════════════════════════════════════════════════
//  /notifications — Alert Command Center
//
//  Spec ALERT-CENTER §6 — replaces the old "All caught up" empty
//  page that ignored every other alert source on the platform. Reads
//  the aggregated feed from /api/notifications and renders summary
//  cards, tabs, severity filters, market-status banner, and a row
//  list with category-aware action links.
//
//  Refresh cadence (spec §7):
//    Market open    → 20s auto-poll
//    Market closed  → 3 min auto-poll
//    Manual refresh button always available.
// ════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import AppShell from '@/components/layout/AppShell';
import { Card, Button, Loading, Empty } from '@/components/ui';
import { fmt } from '@/lib/utils';
import {
  Bell, CheckCheck, AlertTriangle, AlertCircle, Info, ShieldAlert,
  Activity, TrendingUp, Layers, Wallet, Cpu, RefreshCw, ChevronRight,
  Filter,
} from 'lucide-react';
import type {
  NotificationItem,
  NotificationSeverity,
  NotificationCategory,
} from '@/types';

// ── Local response shape (mirrors /api/notifications GET) ───────
interface NotificationsResponse {
  data:           NotificationItem[];
  unreadCount:    number;
  criticalCount:  number;
  warningCount:   number;
  systemCount:    number;
  marketStatus:   {
    mode:            'live' | 'pre_open' | 'post_close' | 'holiday' | 'weekend' | 'market_closed';
    isOpen:          boolean;
    state:           string;
    label:           string;
    nowIst:          string;
    isHoliday:       boolean;
    reason:          string | null;
    bypassActive:    boolean;
    bypassReason:    string | null;
  };
  mode:           NotificationsResponse['marketStatus']['mode'];
  data_source:    'live' | 'cached' | 'last_close' | 'eod_snapshot';
  as_of:          string;
}

type Tab = 'all' | 'critical' | 'warnings' | NotificationCategory;

const TAB_DEFS: Array<{ key: Tab; label: string }> = [
  { key: 'all',          label: 'All' },
  { key: 'critical',     label: 'Critical' },
  { key: 'warnings',     label: 'Warnings' },
  { key: 'signal',       label: 'Signals' },
  { key: 'manipulation', label: 'Manipulation' },
  { key: 'watchlist',    label: 'Watchlist' },
  { key: 'portfolio',    label: 'Portfolio' },
  { key: 'risk',         label: 'Risk' },
  { key: 'system',       label: 'System' },
];

const CATEGORY_META: Record<NotificationCategory, { color: string; bg: string; label: string; Icon: React.ElementType }> = {
  market_status: { color: '#92400E', bg: '#FEF3C7', label: 'Market',       Icon: Activity },
  signal:        { color: '#1D4ED8', bg: '#DBEAFE', label: 'Signal',       Icon: TrendingUp },
  ranking:       { color: '#15803D', bg: '#DCFCE7', label: 'Ranking',      Icon: Layers },
  manipulation:  { color: '#B91C1C', bg: '#FEE2E2', label: 'Manipulation', Icon: ShieldAlert },
  risk:          { color: '#C2410C', bg: '#FFEDD5', label: 'Risk',         Icon: AlertTriangle },
  watchlist:     { color: '#1D4ED8', bg: '#DBEAFE', label: 'Watchlist',    Icon: Bell },
  portfolio:     { color: '#15803D', bg: '#DCFCE7', label: 'Portfolio',    Icon: Wallet },
  system:        { color: '#475569', bg: '#F1F5F9', label: 'System',       Icon: Cpu },
};

const SEVERITY_META: Record<NotificationSeverity, { color: string; bg: string; label: string; Icon: React.ElementType }> = {
  critical: { color: '#B91C1C', bg: '#FEE2E2', label: 'CRITICAL', Icon: AlertCircle  },
  warning:  { color: '#92400E', bg: '#FEF3C7', label: 'WARNING',  Icon: AlertTriangle },
  info:     { color: '#1D4ED8', bg: '#DBEAFE', label: 'INFO',     Icon: Info          },
  success:  { color: '#15803D', bg: '#DCFCE7', label: 'OK',       Icon: CheckCheck    },
};

const ALL_SEVERITIES: NotificationSeverity[] = ['critical', 'warning', 'info', 'success'];

function safeAgo(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const v = fmt.ago(iso);
    return v && v !== 'Invalid Date' ? v : '—';
  } catch {
    return '—';
  }
}

function safeSymbol(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = String(s).trim().toUpperCase();
  return cleaned && cleaned !== 'NULL' && cleaned !== 'UNDEFINED' ? cleaned : null;
}

function severityOf(item: NotificationItem): NotificationSeverity {
  return SEVERITY_META[item.severity] ? item.severity : 'info';
}

function categoryOf(item: NotificationItem): NotificationCategory {
  return CATEGORY_META[item.category] ? item.category : 'system';
}

export default function NotificationsPage() {
  const [resp,    setResp]    = useState<NotificationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState<string | null>(null);
  const [tab,     setTab]     = useState<Tab>('all');
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const [lastAt, setLastAt] = useState<string | null>(null);

  // Ref tracks the latest market-open state so the polling closure
  // always reads the freshest value. Without this, the setTimeout body
  // captures `resp` from the render that armed the timer and stays
  // there for the life of the effect — meaning a market that opens
  // mid-session is still polled at 180s, and a market that closes
  // keeps pounding at 20s. Updating the ref on every render keeps the
  // closure honest without re-arming the timer.
  const isOpenRef = useRef<boolean>(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: NotificationsResponse = await res.json();
      setResp({
        ...json,
        data: Array.isArray(json.data) ? json.data : [],
      });
      isOpenRef.current = json?.marketStatus?.isOpen === true;
      setErr(null);
      setLastAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + adaptive polling. Slow 180s cadence when market
  // is closed (data is immutable until open), 20s during the session.
  // The next interval is computed from `isOpenRef.current` immediately
  // BEFORE arming the next setTimeout, so a session opening or closing
  // takes effect on the very next tick.
  useEffect(() => {
    load();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && !document.hidden) {
        await load();
      }
      if (cancelled) return;
      const next = isOpenRef.current ? 20_000 : 180_000;
      timer = setTimeout(tick, next);
    };
    timer = setTimeout(tick, 20_000);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const items = resp?.data ?? [];

  const markRead = async (id: string): Promise<void> => {
    // Idempotent optimistic update. Looks up the current row state
    // first so a duplicate call (e.g. rapid double-click, or a stale
    // poll re-running the click) can't double-decrement the unread
    // counter. The row's onClick already guards against this in
    // normal flow, but the defence is cheap.
    let wasUnread = false;
    setResp((prev) => {
      if (!prev) return prev;
      const target = prev.data.find((n) => n.id === id);
      if (!target || target.isRead) return prev;     // already read → no-op
      wasUnread = true;
      return {
        ...prev,
        data: prev.data.map((n) => n.id === id ? { ...n, isRead: true } : n),
        unreadCount: Math.max(0, prev.unreadCount - 1),
      };
    });
    if (!wasUnread) return;                          // skip API call too

    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch { /* swallow — next poll will reconcile */ }
  };

  const markAll = async () => {
    setResp((prev) => prev && {
      ...prev,
      data: prev.data.map((n) => ({ ...n, isRead: true })),
      unreadCount: 0,
    });
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch { /* swallow — next poll will reconcile */ }
  };

  // Apply tab + filters. Sorting was already done server-side by the
  // aggregator (critical → warning → info, then newest within bucket).
  const filtered = useMemo(() => {
    const symFilter = symbolFilter.trim().toUpperCase();
    return items.filter((n) => {
      if (showUnreadOnly && n.isRead) return false;
      if (tab === 'critical' && severityOf(n) !== 'critical') return false;
      if (tab === 'warnings' && severityOf(n) !== 'warning')  return false;
      if (tab !== 'all' && tab !== 'critical' && tab !== 'warnings'
          && categoryOf(n) !== tab) return false;
      if (symFilter) {
        const sym = safeSymbol(n.symbol);
        if (!sym || !sym.includes(symFilter)) return false;
      }
      return true;
    });
  }, [items, tab, showUnreadOnly, symbolFilter]);

  // Counts available even before resp settles — derive from items.
  const counts = useMemo(() => {
    const out = { critical: 0, warning: 0, info: 0, success: 0, unread: 0, system: 0 };
    for (const n of items) {
      out[severityOf(n)]++;
      if (!n.isRead) out.unread++;
      if (categoryOf(n) === 'system' || categoryOf(n) === 'market_status') out.system++;
    }
    return out;
  }, [items]);

  const ms = resp?.marketStatus;
  const isMarketOpen = ms?.isOpen === true;

  return (
    <AppShell title="Alerts & Notifications">
      <div className="page">
        {/* ── Header ───────────────────────────────────────────── */}
        <div className="page__header">
          <div>
            <h1>Alerts & Notifications</h1>
            <p style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span>{counts.unread} unread · {items.length} total</span>
              {ms && (
                <span
                  title={ms.label}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: '2px 8px', borderRadius: 99,
                    background: isMarketOpen ? '#DCFCE7' : '#FEF3C7',
                    color:      isMarketOpen ? '#15803D' : '#92400E',
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: isMarketOpen ? '#15803D' : '#D97706',
                    animation: isMarketOpen ? 'pulse 1.5s ease-in-out infinite' : 'none',
                  }} />
                  {isMarketOpen ? 'LIVE'
                    : ms.mode === 'pre_open' ? 'PRE-OPEN'
                    : ms.mode === 'post_close' ? 'MARKET CLOSED'
                    : ms.mode === 'holiday' ? 'HOLIDAY'
                    : ms.mode === 'weekend' ? 'WEEKEND'
                    : 'CLOSED'}
                </span>
              )}
              {lastAt && <span style={{ color: '#94A3B8', fontSize: 11 }}>· updated {lastAt}</span>}
              {resp?.data_source && (
                <span style={{
                  fontSize: 10, color: '#475569', background: '#F1F5F9',
                  padding: '1px 8px', borderRadius: 99, fontWeight: 600,
                }}>
                  data: {resp.data_source}
                </span>
              )}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
              <RefreshCw size={13} /> Refresh
            </Button>
            {counts.unread > 0 && (
              <Button variant="secondary" size="sm" onClick={markAll}>
                <CheckCheck size={14} /> Mark all read
              </Button>
            )}
          </div>
        </div>

        {/* ── Closed-market banner ─────────────────────────────── */}
        {ms && !ms.isOpen && (
          <div style={{
            background: '#FEF3C7', borderRadius: 10, padding: '12px 18px',
            marginBottom: 16, border: '1px solid #FDE68A',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <AlertTriangle size={20} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: '#92400E', marginBottom: 4 }}>
                Market Closed — Showing last available alerts
                {ms.bypassActive && (
                  <span title={ms.bypassReason ?? ''} style={{
                    marginLeft: 8, fontSize: 10, color: '#7C2D12', background: '#FEE2E2',
                    padding: '1px 8px', borderRadius: 99, fontWeight: 700,
                  }}>
                    BYPASS ENV SET
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#78350F' }}>
                These are not live intraday alerts. Manipulation events, breaches, and system items
                are sourced from the last close (or the most recent cached snapshot)
                {ms.reason ? ` — ${ms.reason}.` : '.'}
              </div>
            </div>
          </div>
        )}

        {/* ── Summary cards ────────────────────────────────────── */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12, marginBottom: 16,
        }}>
          <SummaryCard label="Critical" value={counts.critical} severity="critical" onClick={() => setTab('critical')} active={tab === 'critical'} />
          <SummaryCard label="Warnings" value={counts.warning} severity="warning"  onClick={() => setTab('warnings')}  active={tab === 'warnings'}  />
          <SummaryCard label="Unread"   value={counts.unread}  severity="info"     onClick={() => { setTab('all'); setShowUnreadOnly(true); }} active={showUnreadOnly} />
          <SummaryCard label="System"   value={counts.system}  severity="info"     onClick={() => setTab('system')}    active={tab === 'system'}    />
        </div>

        {/* ── Tabs ─────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12,
          borderBottom: '1px solid #E2E8F0', paddingBottom: 8,
        }}>
          {TAB_DEFS.map((t) => {
            const active = tab === t.key;
            const tabCount =
                t.key === 'all'        ? items.length
              : t.key === 'critical'   ? counts.critical
              : t.key === 'warnings'   ? counts.warning
              : items.filter((n) => categoryOf(n) === t.key).length;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="btn btn--secondary btn--sm"
                style={{
                  background: active ? '#1E293B' : '#F1F5F9',
                  color:      active ? 'white'   : '#475569',
                  borderColor: active ? '#1E293B' : '#E2E8F0',
                  fontSize: 12, fontWeight: 600,
                }}
              >
                {t.label}
                <span style={{
                  marginLeft: 6, padding: '1px 6px', borderRadius: 99,
                  background: active ? 'rgba(255,255,255,0.2)' : '#E2E8F0',
                  color: active ? 'white' : '#64748B',
                  fontSize: 10, fontWeight: 700,
                }}>{tabCount}</span>
              </button>
            );
          })}
        </div>

        {/* ── Filters row ──────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748B', fontSize: 12 }}>
            <Filter size={12} /> Filters:
          </div>
          <input
            placeholder="Filter by symbol (e.g. RELIANCE)"
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            style={{
              padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6,
              fontSize: 12, minWidth: 220,
            }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569' }}>
            <input type="checkbox" checked={showUnreadOnly} onChange={(e) => setShowUnreadOnly(e.target.checked)} />
            Unread only
          </label>
          {(symbolFilter || showUnreadOnly || tab !== 'all') && (
            <button
              onClick={() => { setSymbolFilter(''); setShowUnreadOnly(false); setTab('all'); }}
              style={{
                background: 'none', border: 'none', color: '#3B82F6',
                fontSize: 12, cursor: 'pointer', fontWeight: 600,
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* ── Showing-X-of-Y status line ───────────────────────────
             Operators reported the list looking truncated (5–6 rows
             rendered out of 100 alerts). Two real causes existed:
               1. PER_SOURCE_LIMIT capped the API at 100 rows (fixed).
               2. The list silently rendered the filtered subset, with
                  no indicator that a tab/filter was clipping the
                  result. Without this line the only signal of a hidden
                  filter was the counts disagreeing with the visible
                  rows — easy to miss. */}
        {!loading && !err && items.length > 0 && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '8px 14px', marginBottom: 8,
            background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8,
            fontSize: 12, color: '#475569',
          }}>
            <span>
              Showing <strong>{filtered.length}</strong>
              {filtered.length !== items.length && (
                <> of <strong>{items.length}</strong> alerts</>
              )}
              {filtered.length === items.length && <> alerts</>}
            </span>
            {(tab !== 'all' || showUnreadOnly || symbolFilter) && (
              <>
                <span style={{ color: '#94A3B8' }}>· filters active:</span>
                {tab !== 'all' && (
                  <span style={{
                    background: '#DBEAFE', color: '#1D4ED8', padding: '1px 8px',
                    borderRadius: 99, fontSize: 11, fontWeight: 600,
                  }}>tab: {tab}</span>
                )}
                {showUnreadOnly && (
                  <span style={{
                    background: '#DBEAFE', color: '#1D4ED8', padding: '1px 8px',
                    borderRadius: 99, fontSize: 11, fontWeight: 600,
                  }}>unread only</span>
                )}
                {symbolFilter && (
                  <span style={{
                    background: '#DBEAFE', color: '#1D4ED8', padding: '1px 8px',
                    borderRadius: 99, fontSize: 11, fontWeight: 600,
                  }}>symbol: {symbolFilter.toUpperCase()}</span>
                )}
                <button
                  onClick={() => { setTab('all'); setShowUnreadOnly(false); setSymbolFilter(''); }}
                  style={{
                    marginLeft: 'auto', background: 'none', border: 'none',
                    color: '#3B82F6', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Clear all filters
                </button>
              </>
            )}
          </div>
        )}

        {/* ── List ───────────────────────────────────────────────── */}
        <Card flush>
          {loading && items.length === 0 ? (
            <Loading text="Loading alerts…" />
          ) : err && items.length === 0 ? (
            <Empty
              icon={AlertCircle}
              title="Couldn't load alerts"
              description={err}
              action={<Button variant="secondary" size="sm" onClick={load}><RefreshCw size={14} /> Retry</Button>}
            />
          ) : filtered.length === 0 ? (
            <Empty
              icon={Bell}
              title={items.length === 0 ? 'All clear' : 'No alerts match your filters'}
              description={items.length === 0
                ? 'No alerts in the system right now. The page auto-refreshes when new events land.'
                : `${items.length} alert${items.length === 1 ? '' : 's'} loaded but none match the active tab/filter combination.`}
              action={items.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={() => { setSymbolFilter(''); setShowUnreadOnly(false); setTab('all'); }}>
                  Clear filters
                </Button>
              ) : undefined}
            />
          ) : (
            // Stable composite key: even if the API ever returns two rows
            // with the same composite id (shouldn't happen — the route
            // dedups by id — but defensive), index-suffixing keeps React
            // from collapsing duplicates into a single rendered row.
            filtered.map((n, idx) => (
              <NotificationRow
                key={`${n.id}-${idx}`}
                item={n}
                marketOpen={isMarketOpen}
                onMarkRead={markRead}
              />
            ))
          )}
        </Card>
      </div>
    </AppShell>
  );
}

// ── Summary card ────────────────────────────────────────────────

function SummaryCard({
  label, value, severity, onClick, active,
}: {
  label: string;
  value: number;
  severity: NotificationSeverity;
  onClick?: () => void;
  active?: boolean;
}) {
  const meta = SEVERITY_META[severity];
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
        background: active ? meta.bg : 'white',
        border: `1px solid ${active ? meta.color : '#E2E8F0'}`,
        borderRadius: 10, padding: 14,
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
        transition: 'all 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <meta.Icon size={16} color={meta.color} />
        <span style={{ fontSize: 11, color: '#64748B', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5 }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: meta.color }}>{value}</div>
    </button>
  );
}

// ── Notification row ────────────────────────────────────────────

function NotificationRow({
  item, marketOpen, onMarkRead,
}: {
  item: NotificationItem;
  marketOpen: boolean;
  onMarkRead: (id: string) => Promise<void>;
}) {
  const router = useRouter();
  const sev = SEVERITY_META[severityOf(item)];
  const cat = CATEGORY_META[categoryOf(item)];
  const symbol = safeSymbol(item.symbol);

  // Spec: clicking the row IS the only action — it marks the row
  // read (skipping the API call when it's already read) and then
  // navigates to actionUrl if one is set. The two used to be separate
  // controls (an implicit row click that only marked read, plus a
  // "View" pill that only navigated); folding them is the requested
  // UX.
  //
  // Mark-read fires before navigation. We DO NOT await it: the
  // optimistic update in onMarkRead flips local state immediately so
  // the unread counter drops in the same tick, and the network round-
  // trip happens in the background. Awaiting would delay navigation
  // by the round-trip latency for no UX win.
  const handleClick = () => {
    if (!item.isRead) {
      void onMarkRead(item.id);
    }
    if (item.actionUrl) {
      router.push(item.actionUrl);
    }
  };

  // Cursor stays pointer when there's anywhere to go (mark-read OR
  // navigate); becomes default only when both are no-ops (already
  // read AND no actionUrl).
  const isInteractive = !item.isRead || !!item.actionUrl;

  return (
    <div
      onClick={handleClick}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={(e) => {
        if (!isInteractive) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 14, padding: '14px 20px',
        borderBottom: '1px solid #F1F5F9',
        cursor: isInteractive ? 'pointer' : 'default',
        background: item.isRead ? '#fff' : '#F8FAFC',
        transition: 'background 0.15s',
      }}
    >
      {/* Severity rail */}
      <div style={{
        width: 4, alignSelf: 'stretch', borderRadius: 2,
        background: sev.color, flexShrink: 0,
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{
            background: sev.bg, color: sev.color, fontSize: 10, fontWeight: 700,
            padding: '2px 8px', borderRadius: 99, letterSpacing: 0.5,
          }}>
            {sev.label}
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: cat.bg, color: cat.color, fontSize: 10, fontWeight: 600,
            padding: '2px 8px', borderRadius: 99,
          }}>
            <cat.Icon size={10} /> {cat.label}
          </span>
          {symbol && (
            <span style={{
              background: '#F1F5F9', color: '#1E293B', fontSize: 11, fontWeight: 700,
              padding: '2px 8px', borderRadius: 6, fontFamily: 'monospace',
            }}>
              {symbol}
            </span>
          )}
          {!item.isRead && (
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#3B82F6',
            }} />
          )}
        </div>

        <div style={{
          fontSize: 14, fontWeight: item.isRead ? 500 : 700, color: '#0F172A',
          marginBottom: 2,
        }}>
          {item.title || '—'}
        </div>
        <div style={{ fontSize: 12, color: '#475569', lineHeight: 1.5 }}>
          {item.message || '—'}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, marginTop: 6,
          fontSize: 11, color: '#94A3B8', flexWrap: 'wrap',
        }}>
          <span>{safeAgo(item.createdAt)}</span>
          {item.source && <span>· {item.source}</span>}
          {/* Spec §7 — every row labels its own data source so a
              cached/last-close alert never visually claims to be live. */}
          <span style={{
            padding: '1px 6px', borderRadius: 99, fontSize: 10, fontWeight: 600,
            background: marketOpen ? '#DCFCE7' : '#FEF3C7',
            color:      marketOpen ? '#15803D' : '#92400E',
          }}>
            {marketOpen ? 'Live' : 'Last Close'}
          </span>
        </div>
      </div>

      {/* Affordance only — the entire row is the click target now,
          so this is a visual hint, not its own button. No
          stopPropagation, no separate href; the row's onClick handles
          both mark-read and navigation. */}
      {item.actionUrl && (
        <div
          aria-hidden="true"
          style={{
            display: 'inline-flex', alignItems: 'center',
            color: '#94A3B8', flexShrink: 0, alignSelf: 'center',
          }}
        >
          <ChevronRight size={18} />
        </div>
      )}
    </div>
  );
}
