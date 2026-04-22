export const fmt = {
  currency(val?: number | null, dec = 2): string {
    if (val == null || isNaN(val)) return '—';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', maximumFractionDigits: dec,
    }).format(val);
  },

  number(val?: number | null, dec = 2): string {
    if (val == null || isNaN(val)) return '—';
    return new Intl.NumberFormat('en-IN', { maximumFractionDigits: dec }).format(val);
  },

  percent(val?: number | null, dec = 2): string {
    if (val == null || isNaN(val)) return '—';
    const sign = val >= 0 ? '+' : '';
    return `${sign}${val.toFixed(dec)}%`;
  },

  volume(val?: number | null): string {
    if (val == null || isNaN(val)) return '—';
    if (val >= 1e7)  return `${(val / 1e7).toFixed(2)}Cr`;
    if (val >= 1e5)  return `${(val / 1e5).toFixed(2)}L`;
    if (val >= 1000) return `${(val / 1000).toFixed(1)}K`;
    return val.toString();
  },

  date(d?: string | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  },

  datetime(d?: string | null): string {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  },

  ago(d?: string | null): string {
    if (!d) return '—';
    const sec = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (sec < 60)    return 'just now';
    if (sec < 3600)  return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  },

  initials(name?: string | null): string {
    if (!name) return 'U';
    return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
  },

  truncate(str?: string | null, len = 50): string {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '…' : str;
  },
};

export function changeClass(val?: number | null): string {
  if (!val && val !== 0) return '';
  return val > 0 ? 'positive' : val < 0 ? 'negative' : '';
}

export function changeArrow(val?: number | null): string {
  if (!val && val !== 0) return '';
  return val > 0 ? '▲' : val < 0 ? '▼' : '—';
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms = 300): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function clsx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
