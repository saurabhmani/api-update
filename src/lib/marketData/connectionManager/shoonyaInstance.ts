/**
 * Per-user Shoonya connection instance (wraps ShoonyaTicker).
 *
 * Listeners are wired once. New OAuth credentials replace this user's
 * ticker session only (via updateSession → session bump).
 */

import { EventEmitter } from 'events';
import { logger } from '@/lib/logger';
import { getShoonyaConfig } from '@/lib/broker/oauth/shoonya';
import { NormalizedTickBus } from '@/lib/marketData/brokerProvider/tickBus';
import {
  disconnectShoonyaTicker,
  getShoonyaTickerForUser,
  type ShoonyaTicker,
} from '@/lib/marketData/brokerProvider/shoonya/ticker';
import type {
  BrokerConnectionInstance,
  BrokerConnectionSnapshot,
  BrokerConnectionState,
  ConnectionKey,
} from './types';
import { connectionKeyString } from './types';

const log = logger.child({ component: 'connection.shoonya' });

export class ShoonyaConnectionInstance
  extends EventEmitter
  implements BrokerConnectionInstance
{
  readonly key: ConnectionKey;
  readonly keyString: string;

  private state: BrokerConnectionState = 'idle';
  private sessionVersion = 0;
  private refCount = 0;
  private accessToken = '';
  private uid = '';
  private actid = '';
  private readonly subscriptions = new Set<string>();
  private lastTickAt: number | null = null;
  private lastSuccessfulPollAt: number | null = null;
  private lastError: string | null = null;
  private ticker: ShoonyaTicker | null = null;
  private readonly tickBus = new NormalizedTickBus();
  private updatedAt = new Date().toISOString();
  private readonly numericUserId: number;
  private listenersWired = false;

  constructor(key: ConnectionKey) {
    super();
    this.key = key;
    this.keyString = connectionKeyString(key);
    this.numericUserId = Number(key.userId);
  }

  getSnapshot(): BrokerConnectionSnapshot {
    const st = this.ticker?.getStatus();
    return {
      key: this.key,
      keyString: this.keyString,
      state: this.state,
      sessionVersion: st?.sessionVersion ?? this.sessionVersion,
      refCount: this.refCount,
      subscriptionCount: this.subscriptions.size,
      reconnectAttempts: st?.reconnectAttempts ?? 0,
      lastTickAt:
        st?.lastTickAt
          ? new Date(st.lastTickAt).toISOString()
          : this.lastTickAt
            ? new Date(this.lastTickAt).toISOString()
            : null,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt
        ? new Date(this.lastSuccessfulPollAt).toISOString()
        : null,
      lastError: this.lastError ?? st?.lastError ?? null,
      hasAuthenticatedSession: Boolean(this.accessToken),
      updatedAt: this.updatedAt,
    };
  }

  addRef(): void {
    this.refCount += 1;
    this.touch();
  }

  async release(): Promise<void> {
    this.refCount = Math.max(0, this.refCount - 1);
    this.touch();
    if (this.refCount === 0) {
      await this.disconnect();
    }
  }

  bumpSessionVersion(): number {
    this.sessionVersion += 1;
    this.ticker?.updateSession({
      userId: this.numericUserId,
      accessToken: this.accessToken,
      uid: this.uid,
      actid: this.actid,
    });
    this.touch();
    return this.sessionVersion;
  }

  async authenticate(session: {
    accessToken: string;
    accountId?: string | null;
    authenticatedAt?: string;
  }): Promise<void> {
    this.accessToken = session.accessToken.trim();
    if (!this.accessToken) throw new Error('Shoonya authenticate requires accessToken');

    try {
      const cfg = getShoonyaConfig();
      this.uid = cfg.uid;
    } catch {
      this.uid = (session.accountId || '').replace(/_U$/i, '').trim();
    }
    this.actid = (session.accountId || this.uid).trim() || this.uid;
    this.sessionVersion += 1;
    this.lastSuccessfulPollAt = Date.now();
    this.lastError = null;

    // Replace THIS user's ticker credentials only (generation bump cancels stale reconnect).
    if (this.ticker) {
      this.ticker.updateSession({
        userId: this.numericUserId,
        accessToken: this.accessToken,
        uid: this.uid,
        actid: this.actid,
      });
    }

    this.touch();
    log.info('shoonya_session_authenticated', {
      userId: this.key.userId,
      sessionVersion: this.sessionVersion,
    });
  }

  /** Idempotent; concurrent calls share one connect promise on the ticker. */
  async connect(): Promise<void> {
    if (!this.accessToken || !this.uid) {
      throw new Error('Shoonya connection not authenticated');
    }
    this.state = 'connecting';
    this.touch();
    this.ticker = getShoonyaTickerForUser(
      this.numericUserId,
      {
        userId: this.numericUserId,
        accessToken: this.accessToken,
        uid: this.uid,
        actid: this.actid,
      },
      this.tickBus,
    );
    this.wireListenersOnce(this.ticker);

    // Ensure subscription book is on ticker before connect (restore after auth).
    if (this.subscriptions.size > 0) {
      const items = [...this.subscriptions].map((k) => {
        const [exchange, token] = k.split('|');
        return { exchange: exchange || 'NSE', token: token || k, symbol: token || k };
      });
      this.ticker.subscribeScrips(items);
    }

    await this.ticker.connect();
    const st = this.ticker.getStatus();
    this.state = st.state === 'open' ? 'connected' : st.state === 'expired' ? 'expired' : 'connected';
    this.touch();
  }

  /** Idempotent. */
  async disconnect(): Promise<void> {
    this.listenersWired = false;
    await disconnectShoonyaTicker(this.numericUserId);
    this.ticker = null;
    this.state = 'disconnected';
    this.touch();
  }

  async subscribe(brokerRefs: string[]): Promise<void> {
    for (const ref of brokerRefs) {
      const r = String(ref).trim();
      if (r) this.subscriptions.add(r);
    }
    this.touch();
    if (this.ticker && this.state === 'connected') {
      const items = [...this.subscriptions].map((k) => {
        const [exchange, token] = k.split('|');
        return { exchange: exchange || 'NSE', token: token || k, symbol: token || k };
      });
      this.ticker.subscribeScrips(items);
    }
  }

  async unsubscribe(brokerRefs: string[]): Promise<void> {
    for (const ref of brokerRefs) this.subscriptions.delete(String(ref).trim());
    this.touch();
    if (this.ticker && this.state === 'connected') {
      const items = brokerRefs.map((k) => {
        const [exchange, token] = k.split('|');
        return { exchange: exchange || 'NSE', token: token || k };
      });
      this.ticker.unsubscribeScrips(items);
    }
  }

  /** Prevent duplicate listeners across repeated connect() calls. */
  private wireListenersOnce(ticker: ShoonyaTicker): void {
    if (this.listenersWired) return;
    this.listenersWired = true;
    ticker.on('tick', () => {
      this.lastTickAt = Date.now();
      this.touch();
    });
    ticker.on('session_expired', () => {
      this.state = 'expired';
      this.lastError = 'session_expired';
      this.touch();
      this.emit('login_required', 'session_expired');
    });
    ticker.on('connected', () => {
      this.state = 'connected';
      this.touch();
      this.emit('connected');
    });
  }

  private touch(): void {
    this.updatedAt = new Date().toISOString();
  }
}
