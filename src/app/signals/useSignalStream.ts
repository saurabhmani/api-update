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

export interface SignalStreamState {
  signals:     StreamSignal[];
  changedIds:  Set<number>;
  newIds:      Set<number>;
  connected:   boolean;
  lastPushAt:  number | null;
  streamError: string | null;
}

const INITIAL: SignalStreamState = {
  signals:     [],
  changedIds:  new Set(),
  newIds:      new Set(),
  connected:   false,
  lastPushAt:  null,
  streamError: null,
};

export function useSignalStream(enabled: boolean = true): SignalStreamState {
  const [state, setState] = useState<SignalStreamState>(INITIAL);

  // Previous snapshot cache — used for diff. Stored in a ref so
  // updating it doesn't trigger a re-render; only the diff result
  // (changedIds / newIds) goes into state.
  const prevScoreById = useRef<Map<number, number>>(new Map());
  const prevIds       = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const es = new EventSource('/api/signals/stream');

    const handleFrame = (evt: MessageEvent): void => {
      let payload: { signals?: StreamSignal[] } = {};
      try { payload = JSON.parse(evt.data); } catch { return; }
      const incoming = Array.isArray(payload.signals) ? payload.signals : [];

      const incomingIds = new Set<number>();
      const changedIds  = new Set<number>();
      const newIds      = new Set<number>();

      for (const s of incoming) {
        if (typeof s.id !== 'number') continue;
        incomingIds.add(s.id);

        const prevScore = prevScoreById.current.get(s.id);
        const currScore = Number(s.final_score ?? 0);

        if (!prevIds.current.has(s.id)) {
          // Wasn't in the previous snapshot → this is a NEW row.
          // Only flag as "new" if we've seen at least one previous
          // snapshot. On the very first frame, every row is
          // technically new but we don't want to flash the entire
          // table on initial load.
          if (prevIds.current.size > 0) newIds.add(s.id);
        } else if (prevScore != null && prevScore !== currScore) {
          changedIds.add(s.id);
        }

        prevScoreById.current.set(s.id, currScore);
      }

      // Drop IDs that fell off the list from the score-cache so it
      // doesn't grow unbounded on a long-lived connection.
      for (const oldId of prevIds.current) {
        if (!incomingIds.has(oldId)) prevScoreById.current.delete(oldId);
      }
      prevIds.current = incomingIds;

      setState({
        signals:     incoming,
        changedIds,
        newIds,
        connected:   true,
        lastPushAt:  Date.now(),
        streamError: null,
      });
    };

    // `event: snapshot` = initial push on connect (no flashes)
    // `event: signals`  = periodic update (compute diff flashes)
    es.addEventListener('snapshot', handleFrame);
    es.addEventListener('signals',  handleFrame);

    es.addEventListener('error', () => {
      // EventSource's `error` event fires on BOTH transient blips
      // (network hiccups — readyState CONNECTING) and permanent
      // failures (readyState CLOSED). We only surface the latter
      // because transient re-connects are handled by the browser.
      setState((prev) => ({
        ...prev,
        connected:   es.readyState === EventSource.OPEN,
        streamError: es.readyState === EventSource.CLOSED
          ? 'Stream closed — browser will retry'
          : prev.streamError,
      }));
    });

    // The EventSource is considered "open" once the server sends
    // any frame (including the ': connected' comment on connect).
    // The browser doesn't fire a separate 'open' event type, so we
    // treat receipt of the first frame as open — the handler above
    // sets connected=true.

    return () => {
      es.close();
    };
  }, [enabled]);

  return state;
}
