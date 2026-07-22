'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, LogOut, Plug, RefreshCw } from 'lucide-react';
import { clearKiteSession, getKiteSession } from '@/lib/kite/browser-session';
import {
  disconnectKiteSession,
  resolveConnectedState,
  verifyKiteProfile,
  type LocalKiteSession,
} from '@/lib/kite/browser-connection';
import styles from './dashboard.module.scss';

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type KitePanelState =
  | { status: 'checking' }
  | { status: 'not_connected'; remoteInvalidationWarning?: string }
  | { status: 'verifying' }
  | { status: 'connected'; userName: string; userId: string; broker: string }
  | { status: 'verification_failed'; message: string }
  | { status: 'temporary_failure'; message: string };

function readLocalKiteSession(): LocalKiteSession | null {
  const session = getKiteSession();
  if (!session) return null;

  const authenticatedAt = new Date(session.authenticatedAt);
  if (Number.isNaN(authenticatedAt.getTime())) {
    clearKiteSession();
    return null;
  }

  if (Date.now() - authenticatedAt.getTime() > SESSION_MAX_AGE_MS) {
    clearKiteSession();
    return null;
  }

  return {
    kiteUserId: session.kiteUserId,
    accessToken: session.accessToken,
    authenticatedAt: session.authenticatedAt.trim(),
  };
}

function StatusDot({ tone }: { tone: 'green' | 'amber' | 'grey' }) {
  return <span className={`${styles.dot} ${styles[`dot--${tone}`]}`} />;
}

export default function KiteConnectionPanel() {
  const [panelState, setPanelState] = useState<KitePanelState>({ status: 'checking' });
  const verifyGenerationRef = useRef(0);

  const verifySession = useCallback(async () => {
    const generation = ++verifyGenerationRef.current;
    const session = readLocalKiteSession();

    if (!session) {
      if (generation === verifyGenerationRef.current) {
        setPanelState({ status: 'not_connected' });
      }
      return;
    }

    setPanelState({ status: 'verifying' });

    const result = await verifyKiteProfile(session);
    if (generation !== verifyGenerationRef.current) return;

    const next = resolveConnectedState(session, result);
    if (next.status === 'connected') {
      setPanelState(next);
      return;
    }

    if (next.status === 'temporary_failure') {
      setPanelState({ status: 'temporary_failure', message: next.message });
      return;
    }

    setPanelState({ status: 'verification_failed', message: next.message });
  }, []);

  useEffect(() => {
    void verifySession();
  }, [verifySession]);

  const handleDisconnect = () => {
    verifyGenerationRef.current += 1;
    setPanelState({ status: 'not_connected' });

    void disconnectKiteSession().then((outcome) => {
      if (outcome.kind === 'suppressed') return;
      if (outcome.warning) {
        setPanelState({
          status: 'not_connected',
          remoteInvalidationWarning: outcome.warning,
        });
      } else {
        setPanelState({ status: 'not_connected' });
      }
    });
  };

  const handleRetryVerification = () => {
    void verifySession();
  };

  const showDisconnect =
    panelState.status === 'verifying'
    || panelState.status === 'connected'
    || panelState.status === 'temporary_failure';

  return (
    <section className={styles.panel} aria-label="Zerodha Kite connection">
      <div className={styles.panelHead}>
        <div className={styles.panelTitle}>
          <Link2 size={14} />
          <span>Zerodha Kite</span>
        </div>
        <div className={styles.kitePanelActions}>
          {panelState.status === 'checking' && (
            <span className={`${styles.statusPill} ${styles['statusPill--grey']}`}>
              Checking…
            </span>
          )}

          {panelState.status === 'verifying' && (
            <span className={`${styles.statusPill} ${styles['statusPill--blue']}`}>
              <StatusDot tone="grey" />
              Verifying
            </span>
          )}

          {panelState.status === 'connected' && (
            <span className={`${styles.statusPill} ${styles['statusPill--green']}`}>
              <StatusDot tone="green" />
              Connected
            </span>
          )}

          {panelState.status === 'verification_failed' && (
            <span className={`${styles.statusPill} ${styles['statusPill--amber']}`}>
              <StatusDot tone="amber" />
              Verification failed
            </span>
          )}

          {panelState.status === 'temporary_failure' && (
            <span className={`${styles.statusPill} ${styles['statusPill--amber']}`}>
              <StatusDot tone="amber" />
              Verification unavailable
            </span>
          )}

          {panelState.status === 'not_connected' && (
            <span className={`${styles.statusPill} ${styles['statusPill--grey']}`}>
              <StatusDot tone="grey" />
              Not connected
            </span>
          )}

          {showDisconnect && (
            <button
              type="button"
              className={`${styles.statusPill} ${styles['statusPill--amber']}`}
              onClick={handleDisconnect}
            >
              <LogOut size={11} />
              Disconnect Zerodha
            </button>
          )}

          {panelState.status === 'temporary_failure' && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={handleRetryVerification}
            >
              <RefreshCw size={14} />
              Retry verification
            </button>
          )}

          {panelState.status === 'not_connected' && (
            <a href="/api/kite/auth/start" className={styles.btnPrimary}>
              <Plug size={14} />
              Connect Zerodha
            </a>
          )}

          {panelState.status === 'verification_failed' && (
            <a href="/api/kite/auth/start" className={styles.btnPrimary}>
              <Plug size={14} />
              Connect Zerodha
            </a>
          )}
        </div>
      </div>

      {panelState.status === 'connected' && (
        <dl className={styles.kiteProfileDetails}>
          <div className={styles.kiteProfileItem}>
            <dt className={styles.kiteProfileLabel}>User</dt>
            <dd className={styles.kiteProfileValue}>{panelState.userName}</dd>
          </div>
          <div className={styles.kiteProfileItem}>
            <dt className={styles.kiteProfileLabel}>User ID</dt>
            <dd className={styles.kiteProfileValue}>{panelState.userId}</dd>
          </div>
          <div className={styles.kiteProfileItem}>
            <dt className={styles.kiteProfileLabel}>Broker</dt>
            <dd className={styles.kiteProfileValue}>{panelState.broker}</dd>
          </div>
        </dl>
      )}

      <p className={styles.panelHelper}>
        {panelState.status === 'checking' && 'Checking for a stored Zerodha session in this browser tab.'}
        {panelState.status === 'verifying' && 'Verifying your Zerodha session with Kite.'}
        {panelState.status === 'connected' && 'Zerodha session verified for Kite-backed features in this browser tab.'}
        {panelState.status === 'not_connected' && (
          panelState.remoteInvalidationWarning
          ?? 'Connect your Zerodha account to enable Kite-backed market data in this browser session.'
        )}
        {panelState.status === 'verification_failed' && panelState.message}
        {panelState.status === 'temporary_failure' && panelState.message}
      </p>
    </section>
  );
}
