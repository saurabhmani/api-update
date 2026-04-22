'use client';
import { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, CSSProperties } from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from '@/lib/utils';
import '@/styles/components/_ui.scss';

// ── Button ────────────────────────────────────────────────────────
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  block?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'primary', size = 'md', loading, block,
  className, children, disabled, ...props
}: BtnProps) {
  return (
    <button
      className={clsx(
        'btn',
        `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
      {children}
    </button>
  );
}

// ── Input ─────────────────────────────────────────────────────────
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, ...props }: InputProps) {
  return (
    <div className="field">
      {label && <label>{label}</label>}
      <input className={clsx('input', error && 'input--error', className)} {...props} />
      {error && <div style={{ color: '#DC2626', fontSize: '0.75rem', marginTop: 4 }}>{error}</div>}
      {hint && !error && <div className="hint">{hint}</div>}
    </div>
  );
}

// ── Badge ─────────────────────────────────────────────────────────
type BadgeVariant = 'default' | 'green' | 'red' | 'orange' | 'gray' | 'dark';

export function Badge({ children, variant = 'default', style }: { children: ReactNode; variant?: BadgeVariant; style?: CSSProperties }) {
  const cls = variant === 'default' ? 'badge' : `badge badge--${variant}`;
  return <span className={cls} style={style}>{children}</span>;
}

// ── Card ──────────────────────────────────────────────────────────
export function Card({
  children, title, action, flush, compact, className, style,
}: {
  children: ReactNode;
  title?: string;
  action?: ReactNode;
  flush?: boolean;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={clsx('card', flush && 'card--flush', compact && 'card--compact', className)} style={style}>
      {title && (
        <div className="card__header">
          <h3>{title}</h3>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────
export function StatCard({
  label, value, change, icon: Icon, iconVariant = 'blue', loading,
}: {
  label: string;
  value: ReactNode;
  change?: number;
  icon: React.ElementType;
  iconVariant?: 'blue' | 'green' | 'orange' | 'red';
  loading?: boolean;
}) {
  return (
    <div className="stat-card">
      <div className={`stat-card__icon stat-card__icon--${iconVariant}`}><Icon /></div>
      <div className="stat-card__label">{label}</div>
      {loading
        ? <div className="skeleton" style={{ height: 28, width: '70%', marginTop: 4 }} />
        : <div className="stat-card__value">{value}</div>
      }
      {change !== undefined && !loading && (
        <div className={`stat-card__change ${change >= 0 ? 'up' : 'down'}`}>
          {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(2)}% today
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────
export function Empty({
  icon: Icon, title, description, action,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon /></div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

// ── Loading ───────────────────────────────────────────────────────
export function Loading({ text = 'Loading...' }: { text?: string }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {text}
    </div>
  );
}

// ── Alert banner ─────────────────────────────────────────────────
export function AlertBanner({
  children, variant = 'info', style,
}: {
  children: ReactNode;
  variant?: 'success' | 'error' | 'warning' | 'info';
  style?: CSSProperties;
}) {
  return <div className={`alert-banner alert-banner--${variant}`} style={style}>{children}</div>;
}

// ── Modal ────────────────────────────────────────────────────────
export function Modal({
  open, onClose, title, children, footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal__header">
          <h3>{title}</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
