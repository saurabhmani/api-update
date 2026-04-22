'use client';
import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ───────────────────────────────────────────────────────

export interface KiteStatusState {
  connected: boolean;
  loginRequired: boolean;
  subscribedCount: number;
  ticksCached: number;
  lastError: string | null;
  kiteAuth: 'ok' | 'expired' | 'login_required';
  tokenAgeMinutes: number | null;
  marketIsOpen: boolean;
  marketLabel: string;
  lastTickTime: string | null;
  tickAgeMs: number;
}

export type KitePhase = 'loading' | 'connected' | 'disconnected';

export interface UseKiteStatusReturn {
  status: KiteStatusState | null;
  phase: KitePhase;
  connectKite: () => void;
  refresh: () => Promise<void>;
}

// 30s — the banner only surfaces broker session state; real-time
// market-data freshness is the provider layer's concern, not this
// hook's. The previous 10s cadence created a thundering herd on
// /api/kite/status when multiple pages were mounted.
const POLL_INTERVAL_MS = 30_000;

// ── Hook ────────────────────────────────────────────────────────

export function useKiteStatus(): UseKiteStatusReturn {
  const [status, setStatus] = useState<KiteStatusState | null>(null);
  const [phase, setPhase] = useState<KitePhase>('loading');
  const cancelledRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const phaseRef = useRef<KitePhase>('loading');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/kite/status', { cache: 'no-store' });
      if (!res.ok || cancelledRef.current) return;
      const data = await res.json();

      const newStatus: KiteStatusState = {
        connected: !!data.connected,
        loginRequired: !!data.loginRequired,
        subscribedCount: Number(data.subscribedCount) || 0,
        ticksCached: Number(data.ticksCached) || 0,
        lastError: data.lastError ?? null,
        kiteAuth: data.kiteAuth ?? 'login_required',
        tokenAgeMinutes: data.tokenAgeMinutes ?? null,
        marketIsOpen: !!data.marketIsOpen,
        marketLabel: data.marketLabel ?? '',
        lastTickTime: data.lastTickTime ?? null,
        tickAgeMs: Number(data.tickAgeMs) || 0,
      };

      setStatus(newStatus);

      const isLive = newStatus.connected && !newStatus.loginRequired;
      const prevPhase = phaseRef.current;
      const newPhase: KitePhase = isLive ? 'connected' : 'disconnected';
      phaseRef.current = newPhase;
      setPhase(newPhase);

      // Console logging on state transitions
      if (prevPhase !== newPhase) {
        if (isLive) {
          console.log(
            `[KITE] ✅ Live streaming active — subscribed=${newStatus.subscribedCount} cached=${newStatus.ticksCached}`,
          );
        } else {
          const reason = newStatus.loginRequired
            ? 'login required'
            : newStatus.kiteAuth === 'expired'
              ? 'token expired'
              : newStatus.lastError ?? 'not connected';
          console.log(`[KITE] ❌ Not connected → using fallback (Yahoo) reason=${reason}`);
        }
      }
    } catch {
      // Network failure — don't crash, keep previous state
      if (!cancelledRef.current && phaseRef.current === 'loading') {
        phaseRef.current = 'disconnected';
        setPhase('disconnected');
        console.log('[KITE] ❌ Status probe failed → using fallback (Yahoo)');
      }
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    fetchStatus();
    intervalRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectKite = useCallback(() => {
    console.log('[KITE] CONNECT BUTTON CLICKED');
    window.location.href = '/api/kite/login';
  }, []);

  return { status, phase, connectKite, refresh: fetchStatus };
}
