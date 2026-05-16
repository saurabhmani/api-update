// Canonical TickerStrip lives at src/components/layout/TickerStrip.tsx.
// This file is a thin re-export so any historical import path keeps
// working. Do not add UI here — the previous duplicate hardcoded a
// "LIVE" badge regardless of /api/ticker.mode and we are not bringing
// that bug back.
export { default } from '@/components/layout/TickerStrip';
export type { TickerItem } from '@/app/api/ticker/route';
