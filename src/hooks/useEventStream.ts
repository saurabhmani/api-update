// ════════════════════════════════════════════════════════════════
//  useEventStream — React hook for real-time SSE events
//
//  Usage:
//    const { lastEvent } = useEventStream();
//    useEffect(() => {
//      if (lastEvent?.type === 'signal:new') refetchSignals();
//    }, [lastEvent]);
// ════════════════════════════════════════════════════════════════

'use client';
import { useEffect, useState, useRef, useCallback } from 'react';

interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export function useEventStream(options?: { onEvent?: (event: StreamEvent) => void }) {
  const [lastEvent, setLastEvent] = useState<StreamEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(options?.onEvent);
  onEventRef.current = options?.onEvent;

  useEffect(() => {
    const es = new EventSource('/api/events');
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const event: StreamEvent = JSON.parse(e.data);
        setLastEvent(event);
        onEventRef.current?.(event);
      } catch { /* malformed event */ }
    };

    // Named events
    for (const type of ['signal:new', 'news:new', 'dexter:update', 'pipeline:status']) {
      es.addEventListener(type, (e: any) => {
        try {
          const event: StreamEvent = JSON.parse(e.data);
          setLastEvent(event);
          onEventRef.current?.(event);
        } catch { /* malformed */ }
      });
    }

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, []);

  return { lastEvent, connected };
}
