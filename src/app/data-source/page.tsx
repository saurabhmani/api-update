'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  Database,
  LogOut,
  Plug,
  AlertCircle,
  Info,
} from 'lucide-react';
import { authApi } from '@/lib/apiClient';
import styles from './data-source.module.scss';

type BrokerKey = 'zerodha' | 'shoonya';

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
  persistence_failed: 'Broker login succeeded but saving the connection failed. Please try again.',
  reconnect: '',
};

function friendlyError(code: string | null): string | null {
  if (!code) return null;
  // Only map known safe codes — never render raw query-string text.
  if (!(code in ERROR_MESSAGES)) {
    return 'Something went wrong connecting your data source. Please try again.';
  }
  const mapped = ERROR_MESSAGES[code];
  return mapped || null;
}

export default function DataSourcePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [redirecting, setRedirecting] = useState<BrokerKey | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const errorMessage = useMemo(() => {
    const error = searchParams.get('error');
    const reason = searchParams.get('reason');
    return friendlyError(error) ?? (reason === 'session_expired' ? friendlyError('session_expired') : null);
  }, [searchParams]);

  const brokerHint = searchParams.get('broker');

  useEffect(() => {
    let cancelled = false;

    async function maybeRedirectIfConnected() {
      const error = searchParams.get('error');
      const reason = searchParams.get('reason');
      if (error || reason === 'session_expired' || reason === 'reconnect') return;

      try {
        const res = await fetch('/api/brokers/status', { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.connected) {
          router.replace('/dashboard');
        }
      } catch {
        // stay on page
      }
    }

    void maybeRedirectIfConnected();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams]);

  function connect(broker: BrokerKey) {
    if (redirecting) return;
    setRedirecting(broker);
    const path =
      broker === 'zerodha'
        ? '/api/brokers/zerodha/connect'
        : '/api/brokers/shoonya/connect';
    window.location.href = path;
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
            disabled={loggingOut || !!redirecting}
          >
            <LogOut size={14} />
            {loggingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </header>

        <main className={styles.main}>
          <div className={styles.iconWrap} aria-hidden="true">
            <Database size={28} />
          </div>

          <h1 className={styles.title}>Connect a Data Source</h1>
          <p className={styles.description}>
            Connect your brokerage account to access market data, portfolio information,
            and trading functionality.
          </p>

          {errorMessage && (
            <div className={styles.alert} role="alert">
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          {!errorMessage && searchParams.get('reason') === 'session_expired' && (
            <div className={styles.info} role="status">
              <Info size={16} />
              <span>Your broker session expired. Reconnect to continue to the dashboard.</span>
            </div>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.brokerBtn} ${styles.brokerBtnPrimary}`}
              onClick={() => connect('zerodha')}
              disabled={!!redirecting}
              aria-busy={redirecting === 'zerodha'}
            >
              <Plug size={18} />
              <span className={styles.brokerBtnText}>
                <strong>Continue with Zerodha Kite</strong>
                <small>
                  {redirecting === 'zerodha'
                    ? 'Redirecting to Zerodha…'
                    : brokerHint === 'zerodha'
                      ? 'Retry Zerodha connection'
                      : 'Official Kite Connect login'}
                </small>
              </span>
              <ArrowRight size={16} className={styles.chevron} />
            </button>

            <button
              type="button"
              className={styles.brokerBtn}
              onClick={() => connect('shoonya')}
              disabled={!!redirecting}
              aria-busy={redirecting === 'shoonya'}
            >
              <Plug size={18} />
              <span className={styles.brokerBtnText}>
                <strong>Continue with Shoonya</strong>
                <small>
                  {redirecting === 'shoonya'
                    ? 'Redirecting to Shoonya…'
                    : brokerHint === 'shoonya'
                      ? 'Retry Shoonya connection'
                      : 'Finvasia Shoonya OAuth'}
                </small>
              </span>
              <ArrowRight size={16} className={styles.chevron} />
            </button>
          </div>

          <p className={styles.footnote}>
            Your Quantorus account stays signed in. Broker credentials are stored encrypted
            on the server and are never exposed in the browser.
          </p>
        </main>

        <footer className={styles.footer}>
          <Link href="/login" className={styles.footerLink}>
            Back to login
          </Link>
        </footer>
      </div>
    </div>
  );
}
