export const QUERY_GC_TIME = {
  DEFAULT: 5 * 60_000,
  REFERENCE: 30 * 60_000,
  REAL_TIME: 2 * 60_000,
} as const;

/** Stop React Query polling while the browser tab is hidden. */
export function visibleRefetchInterval(intervalMs: number) {
  return () =>
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
      ? false
      : intervalMs;
}
