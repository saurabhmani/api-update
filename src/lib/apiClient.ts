'use client';

const BASE = '/api';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (res.status === 401 && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data as T;
}

const get  = <T>(path: string) => req<T>(path, { method: 'GET' });
const post = <T>(path: string, body?: unknown) => req<T>(path, { method: 'POST',  body: JSON.stringify(body) });
const put  = <T>(path: string, body?: unknown) => req<T>(path, { method: 'PUT',   body: JSON.stringify(body) });
const patch= <T>(path: string, body?: unknown) => req<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del  = <T>(path: string) => req<T>(path, { method: 'DELETE' });

// ── Auth ──────────────────────────────────────────────────────────
export const authApi = {
  login:         (email: string, password: string) => post('/auth', { action:'login', email, password }),
  verify2fa:     (userId: number, token: string)   => post('/auth', { action:'2fa', userId, token }),
  logout:        ()                                 => post('/auth', { action:'logout' }),
  me:            ()                                 => get('/auth'),
  changePassword:(current_password: string, new_password: string) =>
    put('/user', { action:'change-password', current_password, new_password }),
};

// ── Dashboard ─────────────────────────────────────────────────────
export const dashboardApi = {
  get: () => get('/dashboard'),
};

// ── Market ────────────────────────────────────────────────────────
export const marketApi = {
  search:  (q: string, exchange?: string) =>
    get(`/market?action=search&q=${encodeURIComponent(q)}${exchange ? `&exchange=${exchange}` : ''}`),
  suggest: (q: string) =>
    get(`/market?action=suggest&q=${encodeURIComponent(q)}`),
  ltp:     (keys: string[]) =>
    get(`/market?action=ltp&keys=${encodeURIComponent(keys.join(','))}`),
  quotes:  (keys: string[]) =>
    get(`/market?action=quotes&keys=${encodeURIComponent(keys.join(','))}`),
};

// ── Instruments ───────────────────────────────────────────────────
export const instrumentApi = {
  get: (key: string) => get(`/instruments?key=${encodeURIComponent(key)}`),
};

// ── Charts ────────────────────────────────────────────────────────
export const chartsApi = {
  intraday:   (instrumentKey: string, interval = '1minute') =>
    get(`/charts?instrumentKey=${encodeURIComponent(instrumentKey)}&type=intraday&interval=${interval}`),
  historical: (instrumentKey: string, unit = 'days', interval = '1', from?: string, to?: string) =>
    get(`/charts?instrumentKey=${encodeURIComponent(instrumentKey)}&type=historical&unit=${unit}&interval=${interval}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`),
};

// ── Watchlist ─────────────────────────────────────────────────────
export const watchlistApi = {
  get:    ()                                  => get('/watchlist'),
  add:    (data: Record<string,unknown>)      => post('/watchlist', data),
  remove: (id: number)                        => del(`/watchlist?id=${id}`),
};

// ── Portfolio ─────────────────────────────────────────────────────
export const portfolioApi = {
  positions: () => get('/portfolio?view=positions'),
  summary:   () => get('/portfolio?view=summary'),
  add:       (data: Record<string,unknown>) => post('/portfolio', data),
  update:    (data: Record<string,unknown>) => patch('/portfolio', data),
  delete:    (id: number)                   => del(`/portfolio?id=${id}`),
};

// ── News ──────────────────────────────────────────────────────────
export const newsApi = {
  list:       (params?: string) => get(`/news${params ? `?${params}` : ''}`),
  categories: ()                 => get('/news/categories' as any),
  create:     (data: unknown)    => post('/news', data),
  update:     (data: unknown)    => patch('/news', data),
  delete:     (id: number)       => del(`/news?id=${id}`),
};

// ── Notifications ─────────────────────────────────────────────────
export const notificationsApi = {
  list:    ()           => get('/notifications'),
  markRead:(id?: number)=> post('/notifications', { id }),
  markAll: ()           => post('/notifications', { all: true }),
};

// ── Alerts ───────────────────────────────────────────────────────
export const alertsApi = {
  list:   ()                         => get('/alerts'),
  create: (data: Record<string,any>) => post('/alerts', data),
  update: (data: Record<string,any>) => patch('/alerts', data),
  delete: (id: number)               => del(`/alerts?id=${id}`),
};

// ── Reports ──────────────────────────────────────────────────────
export const reportsApi = {
  list:     ()                               => get('/reports'),
  generate: (type: string, format: string)  => post('/reports', { type, format }),
  download: async (id: number, name: string) => {
    const res = await fetch(`/api/reports?id=${id}&download=true`, { credentials: 'include' });
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  },
};

// ── Rankings ─────────────────────────────────────────────────────
export const rankingsApi = {
  get: (limit = 50) => get(`/rankings?limit=${limit}`),
};

// ── User / Preferences ───────────────────────────────────────────
export const userApi = {
  preferences: ()            => get('/user'),
  savePrefs:   (data: unknown)=> put('/user', data),
};

// ── Admin ────────────────────────────────────────────────────────
export const adminApi = {
  users:      ()               => get('/admin?resource=users'),
  updateUser: (data: unknown)  => put('/admin?resource=user', data),
  auditLogs:  (limit = 100)    => get(`/admin?resource=audit&limit=${limit}`),
  usage:      ()               => get('/admin?resource=usage'),
  flags:      ()               => get('/admin?resource=flags'),
  toggleFlag: (data: unknown)  => put('/admin?resource=flag', data),
  syncData:   (type: string)   => post('/admin', { type }),
};
