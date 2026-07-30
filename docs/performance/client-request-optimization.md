# Client request optimization

## Applied policies

- React Query keeps the existing 30-second global stale time; no long global
  freshness window was introduced for market data.
- Default garbage collection is five minutes and focus refetch is disabled.
  Real-time surfaces opt into explicit polling or focus behavior.
- Polling hooks use visibility-aware intervals and stop while the tab is hidden.
- Query functions receive React Query's `AbortSignal`, cancelling obsolete
  requests after key/parameter changes or unmount.
- Strategy operations search uses `useDeferredValue` so rapid filter typing does
  not issue a request for every intermediate render.
- Stable primitive query-key dimensions are retained for strategy deployment,
  management, and Trade Setup queries.
- Trade Setup's temporary `in_progress` polling runs only while visible and
  stops as soon as data arrives.
- Dashboard requests no longer append a timestamp that defeats identical-request
  reuse. A new request aborts its obsolete predecessor and unmount aborts the
  current request.
- Mutation hooks continue to invalidate only their affected portfolio,
  strategy, alert, or analytics query-key families.

## Deliberately retained

- Real-time signals and operational health retain short stale times.
- Event-stream-driven signal refresh remains enabled.
- Polling is retained where no WebSocket event currently covers the resource,
  but it is suspended for hidden tabs.
