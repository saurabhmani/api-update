'use client';
import { useState, useEffect, useRef, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, TrendingUp, Search, Star, Briefcase,
  Newspaper, Bell, FileText, Settings, Users, Database,
  ClipboardList, Menu, X, LogOut, Activity,
  Zap, Target, Brain, BookOpen, LineChart, FlaskConical, ShieldAlert,
  BarChart3, Cpu,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from '@/lib/utils';
import TickerStrip from './TickerStrip';
import '@/styles/components/_layout.scss';

interface NavItem { href: string; icon: React.ElementType; label: string; }
interface NavGroup { label: string; items: NavItem[]; adminOnly?: boolean; }

const NAV: NavGroup[] = [
  {
    label: 'Main',
    items: [
      { href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { href: '/portfolio', icon: Briefcase,        label: 'Portfolio' },
      { href: '/market',    icon: Search,           label: 'Market Search' },
      { href: '/watchlist', icon: Star,             label: 'Watchlist' },
    ],
  },
  {
    label: 'Decisions & Risk',
    items: [
      { href: '/rankings',      icon: TrendingUp,   label: 'Rankings' },
      { href: '/notifications', icon: Bell,          label: 'Alerts & Notifications' },
      { href: '/reports',       icon: FileText,      label: 'Reports' },
      { href: '/news',          icon: Newspaper,     label: 'News & Insights' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { href: '/intelligence',       icon: Brain,        label: 'Intelligence Hub' },
      { href: '/trade-setups',       icon: Target,       label: 'Trade Setups' },
      { href: '/signals',            icon: Zap,          label: 'Signals' },
      { href: '/options/chain',      icon: LineChart,    label: 'Option Intelligence' },
      { href: '/trade-journal',      icon: BookOpen,     label: 'Trade Journal' },
      { href: '/backtesting',        icon: FlaskConical, label: 'Backtesting' },
      { href: '/manipulation',       icon: ShieldAlert,  label: 'Manipulation Watch' },
      { href: '/dexter',             icon: Cpu,          label: 'Dexter AI' },
      { href: '/news-intelligence',  icon: Newspaper,    label: 'News Intelligence' },
      { href: '/calibration',        icon: BarChart3,    label: 'Calibration' },
    ],
  },
  {
    label: 'Admin',
    adminOnly: true,
    items: [
      { href: '/admin/users',      icon: Users,         label: 'Users' },
      { href: '/admin/news',       icon: Newspaper,     label: 'News Mgmt' },
      { href: '/admin/data',       icon: Database,      label: 'Data Management' },
      { href: '/admin/thresholds', icon: Activity,      label: 'Signal Thresholds' },
      { href: '/admin/pipeline',   icon: Zap,           label: 'Pipeline Control' },
      { href: '/admin/audit',      icon: ClipboardList, label: 'Audit Logs' },
    ],
  },
  {
    label: 'Account',
    items: [{ href: '/settings', icon: Settings, label: 'Settings' }],
  },
];

interface Props { children: ReactNode; title?: string; }

/**
 * Bell-badge data: derived from /api/notifications?summary=1 so the
 * dot/badge can never lie about unread state. Previously the AppShell
 * rendered <span className="dot" /> unconditionally — a permanent red
 * dot regardless of actual unread. Now we poll the summary endpoint:
 *
 *   - market open   → 25s cadence
 *   - market closed → 180s cadence (3 min)
 *
 * The page and the bell hit the same aggregator, so their counts
 * always agree (the page just reads the full feed; the bell reads the
 * summary projection).
 *
 * Non-countable system items (e.g. the Saturday "Market Closed" card)
 * are excluded from unreadCount/criticalCount server-side, so the bell
 * stays clean on weekends with no actionable alerts.
 */
interface NotifBellSummary {
  unreadCount:   number;
  criticalCount: number;
  marketIsOpen:  boolean;
}

function useNotificationsBell(): NotifBellSummary {
  const [summary, setSummary] = useState<NotifBellSummary>({
    unreadCount: 0, criticalCount: 0, marketIsOpen: false,
  });
  // Track latest market-open state in a ref so the polling closure
  // always reads the freshest value without re-arming on every change.
  const isOpenRef = useRef<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchSummary = async () => {
      try {
        const res = await fetch('/api/notifications?summary=1', { cache: 'no-store' });
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        const u = Number(json?.unreadCount)   || 0;
        const c = Number(json?.criticalCount) || 0;
        const isOpen = json?.marketStatus?.isOpen === true;
        isOpenRef.current = isOpen;
        setSummary({ unreadCount: u, criticalCount: c, marketIsOpen: isOpen });
      } catch { /* swallow — next tick will retry */ }
    };

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && !document.hidden) {
        await fetchSummary();
      }
      if (cancelled) return;
      // Open market polls fast (25s), closed market slow (3min).
      // Computed AFTER the fetch so the cadence reacts to market
      // state changes on the very next tick.
      const next = isOpenRef.current ? 25_000 : 180_000;
      timer = setTimeout(tick, next);
    };
    fetchSummary();
    timer = setTimeout(tick, 25_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return summary;
}

export default function AppShell({ children, title }: Props) {
  const [open, setOpen] = useState(false);
  const pathname        = usePathname();
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { unreadCount, criticalCount } = useNotificationsBell();

  return (
    <div className="shell">
      <div className={`sidebar-overlay ${open ? 'show' : ''}`} onClick={() => setOpen(false)} />

      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar__logo">
          <div className="logo-mark">Q</div>
          <div className="logo-text">
            <strong>Quantorus365</strong>
            <small>Intelligence Platform</small>
          </div>
        </div>

        <nav className="sidebar__nav">
          {NAV.map(group => {
            if (group.adminOnly && !isAdmin) return null;
            return (
              <div key={group.label} className="sidebar__group">
                <div className="sidebar__group-label">{group.label}</div>
                {group.items.map(({ href, icon: Icon, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className={`sidebar__item ${pathname.startsWith(href) ? 'active' : ''}`}
                    onClick={() => setOpen(false)}
                  >
                    <Icon />
                    {label}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar__footer">
          <button className="sidebar__logout" onClick={logout}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar__left">
            <button className="topbar__hamburger" onClick={() => setOpen(o => !o)} aria-label="Toggle menu">
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
            {title && <h1 className="topbar__title">{title}</h1>}
          </div>
          <div className="topbar__right">
            <Link
              href="/notifications"
              className="topbar__icon-btn"
              aria-label={
                criticalCount > 0
                  ? `Notifications (${criticalCount} critical, ${unreadCount} unread)`
                  : unreadCount > 0
                    ? `Notifications (${unreadCount} unread)`
                    : 'Notifications'
              }
              style={{ position: 'relative' }}
            >
              <Bell size={17} />
              {/* Bell badge driven by /api/notifications?summary=1.
                  Critical badge wins when criticalCount > 0; otherwise
                  a plain dot for any other unread. No badge at all
                  when both are 0 — Saturdays with only the synthetic
                  "Market Closed" info card do NOT trigger a red dot
                  because that item is server-flagged countable=false. */}
              {criticalCount > 0 ? (
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute', top: -2, right: -4,
                    minWidth: 16, height: 16, padding: '0 4px',
                    borderRadius: 99, background: '#DC2626', color: '#fff',
                    fontSize: 10, fontWeight: 800, lineHeight: '16px',
                    textAlign: 'center', border: '2px solid #fff',
                    boxSizing: 'content-box',
                  }}
                  title={`${criticalCount} critical alert${criticalCount === 1 ? '' : 's'}`}
                >
                  {criticalCount > 99 ? '99+' : criticalCount}
                </span>
              ) : unreadCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="dot"
                  title={`${unreadCount} unread alert${unreadCount === 1 ? '' : 's'}`}
                />
              ) : null}
            </Link>
            <Link href="/settings" aria-label="Profile">
              <div className="topbar__avatar">{fmt.initials(user?.name || user?.email)}</div>
            </Link>
          </div>
        </header>

        <TickerStrip />

        {children}
      </main>
    </div>
  );
}
