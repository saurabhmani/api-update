'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  LogOut,
  Plug,
  AlertCircle,
  Info,
  RefreshCw,
  Radio,
} from 'lucide-react';
import { authApi } from '@/lib/apiClient';
import styles from './data-source.module.scss';

type BrokerKey = 'zerodha' | 'shoonya';

type ConnectionSummary = {
  broker: BrokerKey;
  status: string;
  connected: boolean;
  isActiveDataSource: boolean;
  displayName: string;
  accountId: string | null;
  expiresAt: string | null;
  updatedAt: string;
};

type SafeStatus = {
  connected: boolean;
  broker: BrokerKey | null;
  status: string;
  displayName: string | null;
  accountId: string | null;
  expiresAt: string | null;
  needsSelection?: boolean;
  activeDataSource?: BrokerKey | null;
  connections?: ConnectionSummary[];
  feedStatus?: string;
  lastLiveDataAt?: number | null;
  lastLiveDataAtIso?: string | null;
  feedError?: string | null;
};

type Envelope = {
  provider?: BrokerKey | null;
  status?: string;
  data?: SafeStatus;
};

const BROKERS: Array<{ key: BrokerKey; label: string; connectHint: string }> = [
  { key: 'zerodha', label: 'Zerodha Kite', connectHint: 'Official Kite Connect login' },
  { key: 'shoonya', label: 'Shoonya', connectHint: 'Finvasia Shoonya OAuth' },
];

const ERROR_MESSAGES: Record<string, string> = {
  authentication_failed: 'Broker authentication failed. Please try again.',
  oauth_incomplete: 'Zerodha did not return a complete login response. Please try connecting again.',
  kite_token_exchange:
    'Zerodha rejected the login token. Confirm KITE_API_KEY / KITE_API_SECRET match the app on developers.kite.trade, and that the Redirect URL is exactly the same as KITE_REDIRECT_URL.',
  shoonya_token_exchange:
    'Shoonya rejected the login token. Confirm SHOONYA_CLIENT_ID / SECRET_CODE / UID (UID is usually CLIENT_ID without _U), and that this machine’s public IP is whitelisted in the Shoonya API console.',
  shoonya_invalid_verifier:
    'Shoonya INVALID_VERIFIER — check SHOONYA_UID (trading id, e.g. FN213349, not FN213349_U) and SECRET_CODE.',
  shoonya_ip_whitelist:
    'Shoonya blocked token exchange from this IP. Whitelist your public IP in the Shoonya developer console, then try again.',
  redirect_url_mismatch:
    'Zerodha Redirect URL is wrong for this host. On developers.kite.trade set Redirect URL to https://<this-host>/api/kite/auth/callback, set the same value as KITE_REDIRECT_URL on the server, restart, then connect again. Do not edit localhost in the browser address bar.',
  redis_unavailable: 'Temporary session store unavailable. Ensure Redis is running and try again.',
  missing_code: 'Authorization was incomplete. Please try connecting again.',
  invalid_state: 'Your authentication session expired. Please try again.',
  invalid_transaction:
    'Your broker login session expired or was not found. Start Connect again from this page (do not reuse an old callback URL).',
  cancelled: 'Broker authorization was cancelled.',
  not_configured: 'This broker is not configured on the server yet.',
  session_expired: 'Your broker session expired. Please reconnect to continue.',
  reauth_required: 'Your broker session is no longer valid. Please reconnect to continue.',
  revoked: 'Broker credentials were revoked. Please reconnect to continue.',
  persistence_failed: 'Broker login succeeded but saving the connection failed. Please try again.',
  reconnect: '',
};

function friendlyError(code: string | null): string | null {
  if (!code) return null;
  if (!(code in ERROR_MESSAGES)) {
    return 'Something went wrong connecting your data source. Please try again.';
  }
  return ERROR_MESSAGES[code] || null;
}

function formatRelative(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return 'Never';
  const age = Date.now() - ts;
  if (age < 5_000) return 'Just now';
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function freshnessLabel(status: string | undefined): string {
  switch (status) {
    case 'fresh':
      return 'Fresh';
    case 'delayed':
      return 'Delayed';
    case 'stale':
      return 'Stale';
    case 'waiting_for_data':
      return 'Waiting for data';
    case 'connecting':
    case 'connected':
      return 'Connecting';
    case 'closed_market':
      return 'Market closed';
    case 'login_required':
      return 'Login required';
    case 'error':
    case 'zerodha_error':
    case 'shoonya_error':
      return 'Connection error';
    case 'not_connected':
      return 'Not connected';
    case 'needs_selection':
      return 'Select active source';
    default:
      return status ? status.replace(/_/g, ' ') : 'Unknown';
  }
}

function connectionFor(
  status: SafeStatus | null,
  broker: BrokerKey,
): ConnectionSummary | null {
  return status?.connections?.find((c) => c.broker === broker) ?? null;
}

export default function DataSourcePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<SafeStatus | null>(null);
  const [envelopeStatus, setEnvelopeStatus] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState<BrokerKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<BrokerKey | null>(null);
  const [actionError, setActionError] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);

  const errorMessage = useMemo(() => {
    const error = searchParams.get('error');
    const reason = searchParams.get('reason');
    return friendlyError(error) ?? (reason === 'session_expired' ? friendlyError('session_expired') : null);
  }, [searchParams]);

  const brokerHint = searchParams.get('broker') as BrokerKey | null;
  const connectedOk = searchParams.get('connected') === '1' || searchParams.get('ok') === '1';

  const load = useCallback(async () => {
    setLoading(true);
    setActionError('');
    try {
      const res = await fetch('/api/brokers/status', {
        credentials: 'include',
        cache: 'no-store',
      });
      if (res.status === 401) {
        router.replace('/login?from=/data-source');
        return;
      }
      if (!res.ok) throw new Error('status_failed');
      const body = (await res.json()) as Envelope & SafeStatus;
      const data =
        body?.data && typeof body.data === 'object'
          ? body.data
          : (body as SafeStatus);
      setStatus(data);
      setEnvelopeStatus(typeof body.status === 'string' ? body.status : data.feedStatus);
    } catch {
      setActionError('Unable to load data source status.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const needsSelection =
    searchParams.get('reason') === 'select_data_source'
    || status?.needsSelection === true;

  const feedStatus = envelopeStatus ?? status?.feedStatus;
  const isLoginRequired =
    feedStatus === 'login_required'
    || status?.status === 'expired'
    || status?.status === 'reauth_required'
    || status?.status === 'revoked'
    || searchParams.get('reason') === 'session_expired';
  const isConnectionError =
    feedStatus === 'error'
    || feedStatus === 'zerodha_error'
    || feedStatus === 'shoonya_error'
    || Boolean(status?.feedError);

  function connect(broker: BrokerKey) {
    if (redirecting || busy) return;
    setRedirecting(broker);
    const path =
      broker === 'zerodha'
        ? '/api/brokers/zerodha/connect'
        : '/api/brokers/shoonya/connect';
    window.location.href = path;
  }

  async function setActive(broker: BrokerKey) {
    setBusy(true);
    setActionError('');
    try {
      const res = await fetch('/api/brokers/active', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (body as { error?: string; data?: { error?: string } })?.data?.error
            || (body as { error?: string })?.error
            || 'Unable to switch data source',
        );
      }
      await load();
      setConfirmDisconnect(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to switch data source.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect(broker: BrokerKey) {
    if (confirmDisconnect !== broker) {
      setConfirmDisconnect(broker);
      return;
    }
    setBusy(true);
    setActionError('');
    try {
      const res = await fetch(`/api/brokers/${broker}/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('Disconnect failed');
      setConfirmDisconnect(null);
      await load();
      if (body.needsSelection) {
        router.replace('/data-source?reason=select_data_source');
      }
    } catch {
      setActionError('Unable to disconnect. Please try again.');
      setConfirmDisconnect(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout(e: FormEvent) {
    e.preventDefault();
    setLoggingOut(true);
    try {
      await authApi.logout();
    } catch {
      // still leave
    }
    router.replace('/login');
  }

  const activeLabel = status?.activeDataSource
    ? (status.displayName ?? status.activeDataSource)
    : needsSelection
      ? 'Not selected'
      : 'None';

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandDot} aria-hidden="true" />
            <span className={styles.brandName}>
              quantorus<span className={styles.brandAccent}>365</span>
            </span>
          </div>
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={handleLogout}
            disabled={loggingOut || !!redirecting || busy}
          >
            <LogOut size={14} />
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </header>

        <main className={styles.main}>
          <div className={styles.iconWrap} aria-hidden="true">
            <Database size={28} />
          </div>

          <h1 className={styles.title}>Data Sources</h1>
          <p className={styles.description}>
            Connect Zerodha or Shoonya, choose which one is active, and monitor live-data freshness.
            Connecting a second broker never switches your active source unless you do it here.
          </p>

          {(errorMessage || actionError) && (
            <div className={styles.alert} role="alert">
              <AlertCircle size={16} />
              <span>{actionError || errorMessage}</span>
            </div>
          )}

          {connectedOk && !errorMessage && (
            <div className={styles.info} role="status">
              <CheckCircle2 size={16} />
              <span>Broker connected successfully.</span>
            </div>
          )}

          {needsSelection && (
            <div className={styles.info} role="status">
              <Info size={16} />
              <span>
                Select which connected broker should be your active data source.
                We will not switch automatically.
              </span>
            </div>
          )}

          {isLoginRequired && (
            <div className={styles.alert} role="alert">
              <AlertCircle size={16} />
              <span>Login required — your broker session expired. Reconnect to restore live data.</span>
            </div>
          )}

          {isConnectionError && !isLoginRequired && (
            <div className={styles.alert} role="alert">
              <AlertCircle size={16} />
              <span>
                Connection error
                {status?.feedError ? `: ${status.feedError}` : ' on the active data source.'}
              </span>
            </div>
          )}

          <section className={styles.activePanel} aria-label="Active data source">
            <div className={styles.activeHead}>
              <Radio size={16} />
              <strong>Active data source</strong>
            </div>
            {loading ? (
              <p className={styles.muted}>Loading status…</p>
            ) : (
              <dl className={styles.activeMeta}>
                <div>
                  <dt>Current</dt>
                  <dd>{activeLabel}</dd>
                </div>
                <div>
                  <dt>Freshness</dt>
                  <dd>{freshnessLabel(feedStatus)}</dd>
                </div>
                <div>
                  <dt>Last live data</dt>
                  <dd>{formatRelative(status?.lastLiveDataAt)}</dd>
                </div>
              </dl>
            )}
            {status?.activeDataSource && status.connected && (
              <button
                type="button"
                className={styles.dashboardLink}
                onClick={() => router.push('/dashboard')}
                disabled={busy || !!redirecting}
              >
                Continue to dashboard
                <ArrowRight size={14} />
              </button>
            )}
          </section>

          <div className={styles.brokerGrid}>
            {BROKERS.map(({ key, label, connectHint }) => {
              const conn = connectionFor(status, key);
              const connected = conn?.connected === true;
              const isActive = conn?.isActiveDataSource === true
                || status?.activeDataSource === key;
              const rowStatus = conn?.status
                ?? (connected ? 'active' : 'disconnected');
              const showLoginRequired =
                rowStatus === 'expired'
                || rowStatus === 'reauth_required'
                || rowStatus === 'revoked'
                || (isActive && isLoginRequired);

              return (
                <article
                  key={key}
                  className={`${styles.brokerCard} ${isActive ? styles.brokerCardActive : ''}`}
                >
                  <header className={styles.brokerCardHead}>
                    <div>
                      <h2>{label}</h2>
                      <p className={styles.muted}>
                        {connected
                          ? showLoginRequired
                            ? 'Login required'
                            : isActive
                              ? 'Connected · Active'
                              : 'Connected'
                          : rowStatus === 'error'
                            ? 'Connection error'
                            : 'Not connected'}
                        {conn?.accountId ? ` · ${conn.accountId}` : ''}
                      </p>
                    </div>
                    {isActive && (
                      <span className={styles.activeBadge}>Active</span>
                    )}
                  </header>

                  <div className={styles.brokerActions}>
                    {!connected && (
                      <button
                        type="button"
                        className={
                          key === 'zerodha'
                            ? `${styles.brokerBtn} ${styles.brokerBtnPrimary}`
                            : styles.brokerBtn
                        }
                        onClick={() => connect(key)}
                        disabled={!!redirecting || busy}
                        aria-busy={redirecting === key}
                      >
                        <Plug size={16} />
                        <span className={styles.brokerBtnText}>
                          <strong>
                            {brokerHint === key ? `Retry ${label}` : `Connect ${label}`}
                          </strong>
                          <small>
                            {redirecting === key ? 'Redirecting…' : connectHint}
                          </small>
                        </span>
                      </button>
                    )}

                    {connected && showLoginRequired && (
                      <button
                        type="button"
                        className={`${styles.brokerBtn} ${styles.brokerBtnPrimary}`}
                        onClick={() => connect(key)}
                        disabled={!!redirecting || busy}
                      >
                        <RefreshCw size={16} />
                        <span className={styles.brokerBtnText}>
                          <strong>Reconnect</strong>
                          <small>Session expired — login required</small>
                        </span>
                      </button>
                    )}

                    {connected && !isActive && !showLoginRequired && (
                      <button
                        type="button"
                        className={styles.btnPrimary}
                        onClick={() => void setActive(key)}
                        disabled={busy || !!redirecting}
                      >
                        <CheckCircle2 size={14} />
                        Use as active source
                      </button>
                    )}

                    {connected && (
                      <button
                        type="button"
                        className={styles.btnDanger}
                        onClick={() => void handleDisconnect(key)}
                        disabled={busy || !!redirecting}
                      >
                        <LogOut size={14} />
                        {confirmDisconnect === key ? 'Confirm disconnect' : 'Disconnect'}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {confirmDisconnect && (
            <p className={styles.confirmHint}>
              Click Confirm disconnect again to revoke stored credentials for that broker.
            </p>
          )}

          <div className={styles.toolbar}>
            <button
              type="button"
              className={styles.btnSecondary}
              onClick={() => void load()}
              disabled={loading || busy || !!redirecting}
            >
              <RefreshCw size={14} />
              Refresh status
            </button>
          </div>

          <p className={styles.footnote}>
            Your Quantorus account stays signed in. Broker credentials are stored encrypted
            on the server and are never exposed in the browser.
          </p>
        </main>

        <footer className={styles.footer}>
          <Link href="/dashboard" className={styles.footerLink}>
            Back to dashboard
          </Link>
          <Link href="/settings/data-sources" className={styles.footerLink}>
            Settings
          </Link>
        </footer>
      </div>
    </div>
  );
}
