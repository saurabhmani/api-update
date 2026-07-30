/**
 * Shared streaming lifecycle guarantees for Zerodha + Shoonya.
 *
 * Lifecycle:
 *   credentials → connect → authenticate socket → subscribe → tick
 *   → normalize → keyed liveFeedState → broadcast → reconnect (bounded)
 */

import { logger } from '@/lib/logger';
import {
  setLiveFeedConnectionPhase,
  setLiveFeedLoginRequired,
  type LiveFeedKey,
} from '@/lib/marketData/liveFeedState';

const log = logger.child({ component: 'streaming.lifecycle' });

export const MAX_RECONNECT_ATTEMPTS = 40;
export const RECONNECT_BASE_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;

export type StreamErrorKind = 'permanent_auth' | 'temporary_network' | 'unknown';

export function classifyStreamError(message: string | null | undefined): StreamErrorKind {
  if (!message) return 'unknown';
  // Narrow permanent-auth phrases only — never /fail|invalid|denied/i alone.
  if (
    /\binvalid\s+session\b/i.test(message)
    || /\bsession\s+expired\b/i.test(message)
    || /\binvalid\s+token\b/i.test(message)
    || /\btoken\s+expired\b/i.test(message)
    || /\binvalid\s+api.?key\b/i.test(message)
    || /\bapi.?key.*invalid\b/i.test(message)
    || /\bnot\s+logged\s+in\b/i.test(message)
    || /\blogged\s+out\b/i.test(message)
    || /\blogin\s+required\b/i.test(message)
  ) {
    return 'permanent_auth';
  }
  if (
    /econnreset|econnrefused|etimedout|enetunreach|socket|network|timeout|temporarily|unavailable|503|502|504|broken\s*pipe|ws.*close|disconnect/i.test(
      message,
    )
  ) {
    return 'temporary_network';
  }
  return 'unknown';
}

export function reconnectDelayMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(RECONNECT_BASE_MS * n, RECONNECT_MAX_MS);
}

export interface StreamingLifecycleHooks {
  /** Open the vendor socket for this generation. Must no-op if generation is stale. */
  openWire: (generation: number) => Promise<void> | void;
  /** Tear down the vendor socket; safe to call repeatedly. */
  closeWire: () => Promise<void> | void;
  /** Restore subscriptions after auth/connect. */
  restoreSubscriptions: () => Promise<void> | void;
  onLoginRequired?: (message: string) => void;
  onState?: (state: string) => void;
}

/**
 * Controller embedded in each per-user broker connection instance / ticker.
 */
export class StreamingLifecycle {
  sessionVersion = 0;
  reconnectAttempts = 0;
  permanentAuthFailure = false;
  intentionalClose = false;

  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private readonly subscriptions = new Set<string>();
  private connected = false;
  private connecting = false;

  constructor(
    private readonly label: string,
    private readonly hooks: StreamingLifecycleHooks,
    /** When set, connection phase updates are keyed (Phase 8). */
    private readonly feedKey?: LiveFeedKey,
  ) {}

  private syncFeedPhase(
    phase: 'not_connected' | 'connecting' | 'connected' | 'login_required' | 'error',
    errorMessage?: string | null,
  ): void {
    if (!this.feedKey) return;
    if (phase === 'login_required') {
      setLiveFeedLoginRequired(this.feedKey, errorMessage || 'login_required');
      return;
    }
    setLiveFeedConnectionPhase(this.feedKey, phase, errorMessage);
  }

  getSubscriptionRefs(): string[] {
    return [...this.subscriptions];
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  hasSubscription(ref: string): boolean {
    return this.subscriptions.has(ref);
  }

  addSubscriptions(refs: string[]): string[] {
    const added: string[] = [];
    for (const raw of refs) {
      const ref = String(raw).trim();
      if (!ref || this.subscriptions.has(ref)) continue;
      this.subscriptions.add(ref);
      added.push(ref);
    }
    return added;
  }

  removeSubscriptions(refs: string[]): string[] {
    const removed: string[] = [];
    for (const raw of refs) {
      const ref = String(raw).trim();
      if (!ref || !this.subscriptions.has(ref)) continue;
      this.subscriptions.delete(ref);
      removed.push(ref);
    }
    return removed;
  }

  /** New credentials invalidate in-flight sockets and reconnect timers. */
  bumpSession(reason = 'credentials'): number {
    this.sessionVersion += 1;
    this.permanentAuthFailure = false;
    this.clearReconnectTimer('session_bump');
    this.rejectAuthWaiters(new Error('session_replaced'));
    this.connected = false;
    this.connecting = false;
    log.info('streaming_session_bumped', {
      label: this.label,
      sessionVersion: this.sessionVersion,
      reason,
    });
    return this.sessionVersion;
  }

  isGenerationCurrent(generation: number): boolean {
    return generation === this.sessionVersion && !this.intentionalClose;
  }

  /**
   * Idempotent connect with concurrent-call dedupe.
   * Returns the same promise when already connecting.
   * Resolves once the socket has authenticated (markAuthenticated).
   */
  async connect(): Promise<void> {
    if (this.permanentAuthFailure) {
      throw new Error('login_required');
    }
    if (this.connected && !this.connecting) return;
    if (this.connectPromise) return this.connectPromise;

    this.intentionalClose = false;
    this.connecting = true;
    this.syncFeedPhase('connecting');
    this.hooks.onState?.('connecting');
    const generation = this.sessionVersion;

    this.connectPromise = (async () => {
      try {
        await this.hooks.closeWire();
        if (!this.isGenerationCurrent(generation)) return;
        await this.hooks.openWire(generation);
        if (!this.isGenerationCurrent(generation)) {
          await this.hooks.closeWire();
          return;
        }
        if (this.connected) return;
        await this.waitForAuth(generation);
      } catch (err) {
        this.connecting = false;
        if (this.isGenerationCurrent(generation) && !this.intentionalClose) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg !== 'session_replaced' && msg !== 'disconnected') {
            throw err;
          }
        }
      } finally {
        this.connecting = false;
        this.connectPromise = null;
      }
    })();

    return this.connectPromise;
  }

  /**
   * Called by adapter after socket auth succeeds.
   * Auth alone must NOT mark the feed fresh — only connection phase updates.
   */
  markAuthenticated(generation: number): void {
    if (!this.isGenerationCurrent(generation)) return;
    this.connected = true;
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.permanentAuthFailure = false;
    this.syncFeedPhase('connected');
    this.hooks.onState?.('connected');
    this.resolveAuthWaiters(generation);
    void Promise.resolve(this.hooks.restoreSubscriptions()).catch((err) => {
      log.warn('restore_subscriptions_failed', {
        label: this.label,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /** Idempotent disconnect — cancels reconnect timers. */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.clearReconnectTimer('disconnect');
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.rejectAuthWaiters(new Error('disconnected'));
    this.syncFeedPhase('not_connected');
    await this.hooks.closeWire();
    this.hooks.onState?.('disconnected');
  }

  handleWireClosed(generation: number, errorMessage?: string | null): void {
    if (!this.isGenerationCurrent(generation)) {
      log.info('stale_socket_ignored', {
        label: this.label,
        generation,
        current: this.sessionVersion,
      });
      return;
    }
    this.connected = false;
    this.connecting = false;
    this.rejectAuthWaiters(new Error('disconnected'));
    if (this.intentionalClose || this.permanentAuthFailure) return;

    const kind = classifyStreamError(errorMessage);
    if (kind === 'permanent_auth') {
      this.markPermanentAuthFailure(errorMessage || 'authentication_failed');
      return;
    }
    this.scheduleReconnect(generation);
  }

  markPermanentAuthFailure(message: string): void {
    this.permanentAuthFailure = true;
    this.clearReconnectTimer('permanent_auth');
    this.connected = false;
    this.connecting = false;
    this.syncFeedPhase('login_required', message);
    this.hooks.onState?.('expired');
    this.rejectAuthWaiters(new Error('login_required'));
    this.hooks.onLoginRequired?.(message);
    log.warn('streaming_login_required', { label: this.label, message: message.slice(0, 120) });
  }

  scheduleReconnect(generation: number): void {
    if (this.intentionalClose || this.permanentAuthFailure) return;
    if (!this.isGenerationCurrent(generation)) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.hooks.onState?.('error');
      this.syncFeedPhase('error', 'max reconnect attempts');
      log.error('streaming_max_reconnects', { label: this.label });
      return;
    }

    this.reconnectAttempts += 1;
    const delay = reconnectDelayMs(this.reconnectAttempts);
    this.syncFeedPhase('connecting');
    this.hooks.onState?.('reconnecting');

    log.warn('streaming_reconnect_scheduled', {
      label: this.label,
      attempt: this.reconnectAttempts,
      delayMs: delay,
      generation,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isGenerationCurrent(generation)) return;
      if (this.intentionalClose || this.permanentAuthFailure) return;
      void this.connect().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (classifyStreamError(msg) === 'permanent_auth' || msg === 'login_required') {
          this.markPermanentAuthFailure(msg);
          return;
        }
        this.scheduleReconnect(generation);
      });
    }, delay);
  }

  clearReconnectTimer(reason?: string): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (reason) {
      log.info('streaming_reconnect_cancelled', { label: this.label, reason });
    }
  }

  __hasReconnectTimer(): boolean {
    return this.reconnectTimer != null;
  }

  __isConnected(): boolean {
    return this.connected;
  }

  __isConnecting(): boolean {
    return this.connecting;
  }

  private waitForAuth(generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.authWaiters.push({ generation, resolve, reject });
    });
  }

  private resolveAuthWaiters(generation: number): void {
    const waiters = this.authWaiters;
    this.authWaiters = [];
    for (const w of waiters) {
      if (w.generation === generation) w.resolve();
      else w.reject(new Error('session_replaced'));
    }
  }

  private rejectAuthWaiters(err: Error): void {
    const waiters = this.authWaiters;
    this.authWaiters = [];
    for (const w of waiters) w.reject(err);
  }
}
