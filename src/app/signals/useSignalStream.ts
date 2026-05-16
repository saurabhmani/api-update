'use client';

// ════════════════════════════════════════════════════════════════
//  useSignalStream — EventSource hook for the signals dashboard
//
//  Subscribes to /api/signals/stream and returns:
//    - signals:      latest snapshot (always the full top 50)
//    - changedIds:   Set<number> — signal IDs whose final_score
//                    changed since the last frame. Used by the UI
//                    to flash those rows briefly.
//    - newIds:       Set<number> — IDs that appeared for the first
//                    time since the previous frame (new entrants).
//    - connected:    true while the EventSource is OPEN.
//    - lastPushAt:   unix-ms timestamp of the most recent frame.
//    - streamError:  last error text, or null.
//
//  The hook is diff-based so the consuming UI only animates the
//  handful of rows that actually changed, not the whole table on
//  every frame. Diff runs against a ref (O(n) set union + compare),
//  not React state — no extra renders just to compute diffs.
// ════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

export interface StreamSignal {
  id:           number;
  tradingsymbol?: string;
  symbol?:        string;
  direction?:   string;
  final_score?: number | null;
  confidence_score?: number | null;
  [key: string]: any;
}

/** Last-Known-Good envelope mirrored from the SSE payload — see
 *  /api/signals/stream/route.ts. Frontend uses these fields to gate
 *  state writes against the same rules the HTTP poll obeys. */
export interface StreamEnvelope {
  response_generated_at: string | null;
  validation_status:     'OK' | 'NO_SIGNALS_CONFIRMED' | 'API_ERROR' | 'MARKET_CLOSED' | null;
  empty_confirmed:       boolean;
  latest_batch_id:       string | null;
  main_signals_count:    number;
  buy_count:             number;
  sell_count:            number;
  emerging_count:        number;
  cache_source:          string | null;
  emerging_opportunities: any[] | null;
  /** Set when the stream's off-hours branch fires. The page reads
   *  this and renders the market-data table instead of the (empty)
   *  signals card. Null during live market hours. */
  mode:                  'live' | 'market_closed' | null;
  data_source:           string | null;
  market_data:           any[] | null;
  message:               string | null;
  market_state:          string | null;
  market_label:          string | null;
  /** Server-issued request_id for the frame. Used by /signals
   *  page-level guards to drop stale responses (HTTP poll + SSE
   *  race) — see useSignalsPolling.ts. */
  request_id:            string | null;
}

export interface SignalStreamState {
  signals:     StreamSignal[];
  changedIds:  Set<number>;
  newIds:      Set<number>;
  /** True after the first data frame has arrived. */
  connected:   boolean;
  /** True between mount and either (a) first frame arrival, or
   *  (b) ~12s of waiting — whichever comes first. The UI uses this
   *  to render a "CONNECTING…" pill instead of a scary "OFFLINE"
   *  badge during the natural startup delay. */
  connecting:  boolean;
  lastPushAt:  number | null;
  streamError: string | null;
  /** Last validation envelope from the SSE payload. Null until the
   *  first frame arrives. */
  envelope:    StreamEnvelope | null;
}

const INITIAL: SignalStreamState = {
  signals:     [],
  changedIds:  new Set(),
  newIds:      new Set(),
  connected:   false,
  connecting:  true,
  lastPushAt:  null,
  streamError: null,
  envelope:    null,
};

export function useSignalStream(enabled: boolean = true): SignalStreamState {
  const [state, setState] = useState<SignalStreamState>(INITIAL);

  // Step 7(c) of the budget-fix PR: close the EventSource when the
  // browser tab is hidden. An idle background tab still consumes
  // server quota — every push fires the SSE enrichment fetch even
  // when nobody is watching. A subsequent foreground re-mount
  // re-opens the stream with the current cache state.
  const [hidden, setHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden,
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Previous snapshot cache — used for diff. Stored in a ref so
  // updating it doesn't trigger a re-render; only the diff result
  // (changedIds / newIds) goes into state.
  const prevScoreById = useRef<Map<number, number>>(new Map());
  const prevIds       = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!enabled || hidden || typeof window === 'undefined') return;

    const es = new EventSource('/api/signals/stream');

    // Hard cap on the "connecting" badge — after this we surface
    // OFFLINE so the operator knows the stream is genuinely down.
    // 12s covers the slow-cold-DB-query case (10s timeout + a beat).
    const connectingDeadline = setTimeout(() => {
      setState((prev) => prev.connected
        ? prev
        : { ...prev, connecting: false });
    }, 12_000);

    const handleFrame = (evt: MessageEvent): void => {
      let payload: any = {};
      try { payload = JSON.parse(evt.data); } catch { return; }
      const incoming: StreamSignal[] = Array.isArray(payload.signals) ? payload.signals : [];

      const envelope: StreamEnvelope = {
        response_generated_at:  payload.response_generated_at ?? null,
        validation_status:      payload.validation_status ?? null,
        empty_confirmed:        payload.empty_confirmed === true,
        latest_batch_id:        payload.latest_batch_id ?? null,
        main_signals_count:     Number(payload.main_signals_count ?? incoming.length) || 0,
        buy_count:              Number(payload.buy_count ?? 0) || 0,
        sell_count:             Number(payload.sell_count ?? 0) || 0,
        emerging_count:         Number(payload.emerging_count ?? 0) || 0,
        cache_source:           payload.cache_source ?? null,
        emerging_opportunities: Array.isArray(payload.emerging_opportunities) ? payload.emerging_opportunities : null,
        mode:                   payload.mode === 'market_closed' || payload.mode === 'live' ? payload.mode : null,
        data_source:            payload.data_source ?? null,
        market_data:            Array.isArray(payload.market_data) ? payload.market_data : null,
        message:                payload.message ?? null,
        market_state:           payload.market_state ?? null,
        market_label:           payload.market_label ?? null,
        request_id:             typeof payload.request_id === 'string' ? payload.request_id : null,
      };

      const incomingIds = new Set<number>();
      const changedIds  = new Set<number>();
      const newIds      = new Set<number>();

      for (const s of incoming) {
        if (typeof s.id !== 'number') continue;
        incomingIds.add(s.id);

        const prevScore = prevScoreById.current.get(s.id);
        const currScore = Number(s.final_score ?? 0);

        if (!prevIds.current.has(s.id)) {
          if (prevIds.current.size > 0) newIds.add(s.id);
        } else if (prevScore != null && prevScore !== currScore) {
          changedIds.add(s.id);
        }

        prevScoreById.current.set(s.id, currScore);
      }

      for (const oldId of prevIds.current) {
        if (!incomingIds.has(oldId)) prevScoreById.current.delete(oldId);
      }
      prevIds.current = incomingIds;

      setState({
        signals:     incoming,
        changedIds,
        newIds,
        connected:   true,
        connecting:  false,
        lastPushAt:  Date.now(),
        streamError: null,
        envelope,
      });
    };

    es.addEventListener('snapshot', handleFrame);
    es.addEventListener('signals',  handleFrame);

    // EventSource fires `open` as soon as the response headers arrive
    // — well before the first data frame. We use this to flip from
    // CONNECTING → LIVE the moment the connection is established,
    // rather than waiting up to 10s+ for the server's first DB-backed
    // snapshot. The UI can render a loading skeleton during this gap.
    es.onopen = () => {
      setState((prev) => prev.connected
        ? prev
        : { ...prev, connecting: false, connected: true, streamError: null });
    };

    es.addEventListener('error', () => {
      setState((prev) => ({
        ...prev,
        connected:   es.readyState === EventSource.OPEN,
        // Past the connecting deadline if EventSource gave up.
        connecting:  prev.connecting && es.readyState !== EventSource.CLOSED,
        streamError: es.readyState === EventSource.CLOSED
          ? 'Stream closed — browser will retry'
          : prev.streamError,
      }));
    });

    return () => {
      clearTimeout(connectingDeadline);
      es.close();
    };
  }, [enabled, hidden]);

  return state;
}
