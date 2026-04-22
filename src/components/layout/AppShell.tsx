'use client';
import { useState, ReactNode } from 'react';
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
import KiteStatusButton from '@/components/KiteStatusButton';
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
      { href: '/admin/zerodha',    icon: Zap,           label: 'Zerodha Connect' },
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

export default function AppShell({ children, title }: Props) {
  const [open, setOpen] = useState(false);
  const pathname        = usePathname();
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

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
            <KiteStatusButton />
            <Link href="/notifications" className="topbar__icon-btn" aria-label="Notifications">
              <Bell size={17} />
              <span className="dot" />
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
