'use client';
import { useEffect, useState, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  Zap, Search, TrendingUp, TrendingDown, Activity, Target,
  ChevronRight, RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, AlertTriangle,
} from 'lucide-react';
import Link from 'next/link';
import { useLivePrices } from '@/lib/hooks/useLivePrices';
import { useSignalStream } from './useSignalStream';

// ── Types ─────────────────────────────────────────────────────────
interface SignalRow {
  id:                number;
  tradingsymbol:     string;
  exchange:          string;
  // direction is null for extras (universe rows with no actionable
  // signal). Real signals are always 'BUY' or 'SELL'. The UI layer
  // is responsible for converting null → 'NO SIGNAL' display — the
  // data layer never emits placeholder strings like '—'.
  direction:         string | null;
  // True for WS-universe filler rows that don't have a signal in
  // the database. Distinct from direction so the UI can branch on
  // intent (filler vs unknown direction) without string comparisons.
  isExtra?:          boolean;
  timeframe:         string;
  confidence:        number;
  confidence_score:  number;
  conviction_band:   string | null;
  risk_score:        number;
  risk:              string;
  opportunity_score: number;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number | null;
  risk_reward:       number;
  regime:            string;
  market_stance:     string;
  scenario_tag:      string;
  factor_scores:     Record<string, number> | null;
  // `ltp` is the IMMUTABLE snapshot of the market price at the
  // moment the signal was generated (= the ENTRY). Never mutated
  // anywhere in the code path.
  ltp:               number | null;
  // `pct_change` is the change% at generation time — also frozen.
  pct_change:        number | null;
  // ── Live fields populated per request by the live enricher ──
  livePrice:         number | null;
  livePChange:       number | null;
  liveSource:        string | null;
  // WS frame ts for the last Kite tick on this symbol (ms epoch).
  // Drives the fresh/stale dot in the Live column — null when the
  // price is sourced from Yahoo fallback or missing entirely.
  liveTickTs?:       number | null;
  // ── Live-sanity stage outputs ──
  // Invalidated rows are filtered server-side before reaching
  // the client, so you won't see `true` here in practice — but
  // the field is declared so the penalty/warning fields have a
  // consistent shape.
  live_invalidated?:    boolean;
  live_warnings?:       string[];
  live_penalty_applied?: number;
  generated_at:      string;
}

// ── UI helpers ────────────────────────────────────────────────────
const DIR_STYLE: Record<string, { bg: string; color: string }> = {
  BUY:  { bg: '#F0FDF4', color: '#16A34A' },
  SELL: { bg: '#FEF2F2', color: '#DC2626' },
  HOLD: { bg: '#FFFBEB', color: '#D97706' },
};

// ── Live-cell animation ───────────────────────────────────────────
// Kite-style tick flash: on every price CHANGE we paint a translucent
// green (up) or red (down) background for ~400ms, then fade back to
// default. Pure presentation — no effect on the underlying price
// stream. Fresh/stale dot is computed from the WS frame age: green
// for ≤3s (actively ticking), amber 3–30s (quiet/illiquid), red
// >30s (likely stale or fallback). Source badge (K/Y) is unchanged.
function LiveCell({
  price, pChange, source, tickTs, ltp, direction,
}: {
  price:     number | null;
  pChange:   number | null;
  source:    string | null;
  tickTs:    number | null;
  ltp:       number | null;
  direction: string | null;
}) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (price == null) return;
    const prev = prevPriceRef.current;
    if (prev != null && prev !== price) {
      setFlash(price > prev ? 'up' : 'down');
      const id = setTimeout(() => setFlash(null), 400);
      prevPriceRef.current = price;
      return () => clearTimeout(id);
    }
    prevPriceRef.current = price;
  }, [price]);

  if (price == null || price <= 0) {
    return <div style={{ color: '#CBD5E1', fontSize: 11 }}>—</div>;
  }

  const bg =
    flash === 'up'   ? 'rgba(22,163,74,0.18)' :
    flash === 'down' ? 'rgba(220,38,38,0.18)' :
    'transparent';

  const ageMs = tickTs ? Date.now() - tickTs : null;
  const dotColor =
    ageMs == null                ? '#CBD5E1' :
    ageMs <=  3_000              ? '#16A34A' :
    ageMs <= 30_000              ? '#D97706' :
                                   '#DC2626';
  const dotTitle =
    ageMs == null
      ? 'no tick yet'
      : `last tick ${(ageMs / 1000).toFixed(1)}s ago`;

  // Y = amber = Yahoo (signal-only mode, ~15-min delayed).
  const sourceMap: Record<string, [string, string, string, string]> = {
    yahoo: ['#D97706', '#fff', 'Y', 'Yahoo • ~15-min delayed'],
  };
  const srcCfg = source ? sourceMap[source] : null;

  // Side-aware unrealised P/L vs the frozen entry (`ltp`).
  let pnlPct: number | null = null;
  if (ltp != null && ltp > 0) {
    const diff = direction === 'SELL' ? ltp - price : price - ltp;
    pnlPct = (diff / ltp) * 100;
  }

  return (
    <div style={{
      background: bg,
      transition: 'background-color 400ms ease-out',
      borderRadius: 4,
      padding: '2px 4px',
      margin: '-2px -4px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: '#0F172A' }}>
        <span title={dotTitle} style={{
          display: 'inline-block', width: 6, height: 6, borderRadius: 99,
          background: dotColor,
        }} />
        {fmt.currency(price)}
      </div>
      {pChange != null && (
        <div style={{
          fontSize: 10, fontWeight: 600,
          color: pChange >= 0 ? '#16A34A' : '#DC2626',
        }}>
          {pChange >= 0 ? '+' : ''}{pChange.toFixed(2)}%
        </div>
      )}
      {srcCfg && (
        <span title={srcCfg[3]} style={{
          display: 'inline-block', marginTop: 2,
          fontSize: 8, fontWeight: 800,
          background: srcCfg[0], color: srcCfg[1],
          padding: '1px 4px', borderRadius: 3,
        }}>{srcCfg[2]}</span>
      )}
      {pnlPct != null && (
        <div style={{
          fontSize: 9, fontWeight: 600,
          color: pnlPct >= 0 ? '#16A34A' : '#DC2626',
        }}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
        </div>
      )}
    </div>
  );
}

function SignalChip({ dir, isExtra }: { dir: string | null; isExtra?: boolean }) {
  // Pure UI translation — the data layer is responsible for sending
  // direction=null + isExtra=true; this component decides what that
  // means visually. Never read placeholder strings like '—' here.
  if (isExtra || (dir !== 'BUY' && dir !== 'SELL' && dir !== 'HOLD')) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontWeight: 700,
        background: '#F1F5F9', color: '#94A3B8',
        padding: '3px 9px', borderRadius: 20,
        letterSpacing: 0.3,
      }}>
        <Minus size={11} /> NO SIGNAL
      </span>
    );
  }
  const s = DIR_STYLE[dir] ?? DIR_STYLE.HOLD;
  const Icon = dir === 'BUY' ? ArrowUpRight : dir === 'SELL' ? ArrowDownRight : Minus;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 800, background: s.bg, color: s.color,
      padding: '3px 10px', borderRadius: 20 }}>
      <Icon size={12} /> {dir}
    </span>
  );
}

function ConfBar({ value }: { value: number }) {
  if (!value || value <= 0) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const col = value >= 75 ? '#065F46' : value >= 65 ? '#1D4ED8' : value >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 50, height: 5, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: col, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: col }}>{value}%</span>
    </div>
  );
}

function ConvictionBadge({ band }: { band: string | null }) {
  if (!band || band === 'reject') return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const map: Record<string, [string, string, string]> = {
    high_conviction: ['#D1FAE5', '#065F46', '●●●●'],
    actionable:      ['#DBEAFE', '#1D4ED8', '●●●○'],
    watchlist:       ['#FEF3C7', '#92400E', '●●○○'],
  };
  const cfg = map[band];
  if (!cfg) return null;
  return <span style={{ background: cfg[0], color: cfg[1], fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99 }}>{cfg[2]} {band.replace(/_/g, ' ')}</span>;
}

function ScenarioTag({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <span style={{ fontSize: 10, background: '#EFF6FF', color: '#1D4ED8',
      padding: '1px 7px', borderRadius: 99, fontWeight: 600 }}>
      {tag.replace(/_/g, ' ')}
    </span>
  );
}

// ── Deep search result ────────────────────────────────────────────
function SearchResult({ data, symbol }: { data: any; symbol: string }) {
  if (!data) return null;
  const approved = data.approved ?? false;
  const sig = data.signal;

  return (
    <div style={{ marginTop: 16, padding: 16, background: '#F8FAFC', borderRadius: 10, border: '1px solid #E2E8F0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#1E3A5F' }}>{symbol}</span>
        {sig && <SignalChip dir={sig.direction} />}
        {sig?.risk && (
          <Badge variant={sig.risk === 'High' || sig.risk === 'Very High' ? 'red' : sig.risk === 'Low' ? 'green' : 'orange'}>
            {sig.risk} Risk
          </Badge>
        )}
        {approved
          ? <span style={{ marginLeft: 'auto', fontSize: 12, color: '#16A34A', fontWeight: 700 }}>✓ Signal Approved</span>
          : <span style={{ marginLeft: 'auto', fontSize: 12, color: '#DC2626', fontWeight: 700 }}>✗ Rejected</span>
        }
      </div>

      {approved && sig && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[['Entry', sig.entry_price], ['Stop Loss', sig.stop_loss], ['Target', sig.target1], ['R:R', `1:${sig.risk_reward}`]].map(([l, v]) => (
              <div key={String(l)} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{typeof v === 'number' ? fmt.currency(v) : v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12, color: '#64748B', flexWrap: 'wrap' }}>
            {sig.confidence != null && <span>Confidence: <strong style={{ color: '#0F172A' }}>{sig.confidence}%</strong></span>}
            {sig.scenario_tag && <span>Strategy: <strong>{sig.scenario_tag.replace(/_/g, ' ')}</strong></span>}
            {sig.regime && <span>Regime: <strong>{sig.regime}</strong></span>}
          </div>
        </>
      )}

      {!approved && data.rejection_reasons?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>REJECTION REASONS</div>
          {data.rejection_reasons.map((r: string, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#334155', marginBottom: 4 }}>
              <span style={{ color: '#DC2626', fontWeight: 700, flexShrink: 0 }}>✗</span> {r}
            </div>
          ))}
        </div>
      )}

      {(sig?.factor_scores || data.factor_scores) && (() => {
        const fs = sig?.factor_scores ?? data.factor_scores;
        return (
          <div style={{ marginTop: 10, borderTop: '1px solid #E2E8F0', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 6 }}>FACTOR SCORES</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {Object.entries(fs).map(([k, v]) => (
                <div key={k} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase' }}>
                    {k.replace(/_/g, ' ').slice(0, 12)}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700,
                    color: Number(v) >= 65 ? '#16A34A' : Number(v) >= 45 ? '#D97706' : '#DC2626' }}>
                    {Number(v).toFixed(0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {data.soft_warnings?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#D97706' }}>
          ⚠ {data.soft_warnings.join(' · ')}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  const [signals,  setSignals]  = useState<SignalRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [query,    setQuery]    = useState('');
  const [srResult, setSrResult] = useState<any>(null);
  const [srLoading, setSrLoad]  = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  const [freshness, setFreshness] = useState<any>(null);
  const [termLogs, setTermLogs] = useState<string[]>([]);
  // Kite status polling removed — Yahoo-only mode. Market-hours info
  // now comes exclusively from the /api/signals freshness block.
  const kiteStatus = null as null | {
    connected?:      boolean;
    loginRequired?:  boolean;
    marketIsOpen?:   boolean;
    marketLabel?:    string;
    lastTickTimeIST?: string | null;
    lastTickIST?:    string | null;
    tickAgeMs?:      number | null;
    tickRatePerSec?: number | null;
    lastError?:      string | null;
  };

  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  // Monotonic request id — only the latest issued load() is allowed
  // to write into state. Any response that arrives after a newer
  // request has already been issued is discarded. This is what
  // prevents the heavy-then-light race where a slower stale response
  // overwrites a fresher one.
  const reqSeqRef = useRef(0);
  // Tracks whether the first heavy load has resolved, so we don't
  // start the 2s light poll until there is a stable baseline.
  const pollStartedRef = useRef(false);
  // One-shot guard: the stale-signal auto-refresh fires at most
  // once per page load, regardless of how many times load() runs.
  const autoRanRef = useRef(false);

  const pushLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setTermLogs(prev => [`[${ts}] ${line}`, ...prev].slice(0, 200));
  };

  // `heavy` = trigger pipeline + full refresh (first load, manual refresh).
  // `light` = fast re-read with live-price enrichment only (poll path).
  // The light path hits forceRefresh=false so the API skips the auto-
  // pipeline and just re-runs enrichWithLiveLtp against the DB rows —
  // sub-second round trip, safe to call every 2 seconds.
  const load = async (opts: { spinner?: boolean; heavy?: boolean } = {}) => {
    const { spinner = true, heavy = true } = opts;
    // Claim the next sequence number. Any response whose seq is not
    // the most recent one issued will be dropped on arrival.
    const mySeq = ++reqSeqRef.current;
    if (spinner) setLoading(true);
    try {
      const t0 = Date.now();
      // limit=50 is the target top-N. The server's tier selector
      // already narrows to 50 regardless of what we ask for, so
      // fetching 10000 just forced enrichWithLiveLtp + applyLiveSanity
      // over 10k rows per load — the single biggest cause of the
      // "site is heavy" report. Keeping a small headroom (fetch 50,
      // rely on server-side 200-row pool inside getActiveSignals).
      const url = `/api/signals?action=all&limit=50&forceRefresh=${heavy ? 'true' : 'false'}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await res.json();
      const rows: SignalRow[] = data.signals ?? [];
      // Stale-response guard: if another load() was issued while this
      // one was in flight, drop this result — the newer caller owns
      // the state. Without this check, a slow heavy response or a
      // degraded light response (e.g. WS probe failed, livePrice all
      // null) would clobber a fresher render.
      if (mySeq !== reqSeqRef.current) {
        if (heavy) {
          pushLog(`[API] GET /api/signals  ${res.status}  (dropped — superseded by newer request)  ${Date.now() - t0}ms`);
        }
        return;
      }
      setSignals(rows);
      // ── UI data-flow debug (Phase-4 spec Step 5) ───────────
      // Fires once per API response. Reveals:
      //   - UI SIGNALS   : what came out of the API wire
      //   - SELL COUNT   : how many rows the UI would classify
      //                    as SELL under its OWN matcher
      //   - SAMPLE DIRS  : first few direction values, so case /
      //                    whitespace issues are visible at a glance
      if (typeof window !== 'undefined' && heavy) {
        const sellMatched = rows.filter((s) =>
          String(s.direction ?? '').toUpperCase().trim() === 'SELL'
        ).length;
        const buyMatched = rows.filter((s) =>
          String(s.direction ?? '').toUpperCase().trim() === 'BUY'
        ).length;
        // eslint-disable-next-line no-console
        console.log('[UI SIGNALS]', {
          total:         rows.length,
          buy:           buyMatched,
          sell:          sellMatched,
          api_breakdown: data.direction_breakdown ?? null,
          sample_dirs:   rows.slice(0, 5).map((r) => r.direction),
        });
        // eslint-disable-next-line no-console
        console.log('[SELL COUNT]', sellMatched);
      }
      if (data.freshness) {
        setFreshness(data.freshness);
        // Explicit freshness log — this is the single line to grep
        // for when auditing "is this data from today?"
        console.log('[CLIENT] DATA DATE:', {
          signal_latest: data.freshness.signal_latest_generated,
          signal_age_min: data.freshness.signal_age_minutes,
          candle_latest: data.freshness.candle_latest_ts,
          candle_age_hours: data.freshness.candle_age_hours,
          tick_state: data.freshness.tick_ws_state,
          tick_newest_age_ms: data.freshness.tick_newest_age_ms,
          server_now: data.freshness.server_now,
        });
        if (heavy) {
          pushLog(
            `[FRESH] signal=${data.freshness.signal_latest_generated ?? '—'} (${data.freshness.signal_age_minutes ?? '?'}m)  ` +
            `candle=${data.freshness.candle_latest_ts ?? '—'} (${data.freshness.candle_age_hours ?? '?'}h)  ` +
            `ws=${data.freshness.tick_ws_state}`
          );
        }
      }
      if (heavy) {
        const buys  = rows.filter(s => s.direction === 'BUY').length;
        const sells = rows.filter(s => s.direction === 'SELL').length;
        pushLog(`[API] GET /api/signals  ${res.status}  rows=${rows.length} BUY=${buys} SELL=${sells}  ${Date.now() - t0}ms`);
      }
      // Light polls don't log to avoid flooding the terminal.
    } catch (e: any) {
      if (mySeq === reqSeqRef.current) {
        pushLog(`[API] GET /api/signals FAILED  ${e?.message ?? e}`);
      }
    }
    finally { if (spinner && mySeq === reqSeqRef.current) setLoading(false); }
  };

  // Live prices arrive over a WebSocket from streamServer.ts.
  // Client-side fallback poll of /api/signals kicks in only when the
  // WS stream is silent or pushing all-null frames (e.g. Kite offline
  // AND stream server hasn't picked up Yahoo fallback yet).
  const {
    prices: wsPrices,
    connected: wsConnected,
    lastAt: wsLastAt,
    mode: wsMode,
    marketLabel: wsMarketLabel,
    marketOpen: wsMarketOpen,
  } = useLivePrices();

  // ── Server-Sent Events subscription ────────────────────────────
  // Replaces the need for a periodic /api/signals refetch. The
  // server pushes a fresh top-50 snapshot every 5s; we mirror that
  // into the existing `signals` state so the render path is
  // unchanged. changedIds / newIds drive row flash animations.
  const stream = useSignalStream(true);
  useEffect(() => {
    if (!stream.lastPushAt || stream.signals.length === 0) return;
    setSignals(stream.signals as SignalRow[]);
    pushLog(`[SSE] frame — ${stream.signals.length} signals, ` +
      `${stream.changedIds.size} changed, ${stream.newIds.size} new`);
  }, [stream.lastPushAt]);

  useEffect(() => {
    pushLog('[ENV] mode=' + (process.env.NODE_ENV ?? 'unknown') + '  page=/signals  transport=ws+sse');

    // One initial heavy load to populate signal rows from the DB.
    load({ heavy: true }).finally(() => {
      autoRefreshIfStale();
    });

    // Signal-only / Yahoo-only mode: no WebSocket tick stream any
    // more, so we top up the table with a light 10s poll. /api/signals
    // reads from the DB + a cached Yahoo fetch (PRICE_CACHE_TTL_MS=8s
    // by default), so a 10s poll sits almost entirely on cache hits
    // and never hammers Yahoo directly. Skipped while a heavier load
    // is already in flight to avoid piling up requests.
    const pollId = setInterval(() => {
      if (loading) return;
      load({ spinner: false, heavy: false });
    }, 10_000);

    return () => {
      clearInterval(pollId);
      // Bump the seq so any in-flight response is discarded on arrival.
      reqSeqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wsConnected) pushLog('[WS] connected — receiving live prices');
    else             pushLog('[WS] disconnected — attempting reconnect');
  }, [wsConnected]);

  // Heartbeat tick — forces a re-render so the "LAST TICK: Xs ago"
  // staleness indicator stays fresh even when the WS is silent.
  // Cheap (single state bump), but at 1s on a 50-row signal table
  // it adds up to measurable render work. 5s granularity is plenty
  // for a "seconds ago" display — nobody reads the staleness clock
  // with 1-second precision.
  const [, setUiTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setUiTick((t) => (t + 1) % 1_000_000), 5_000);
    return () => clearInterval(id);
  }, []);

  // ── Yahoo-fallback refresh poll ─────────────────────────────────
  // When Kite WS is silent (not authenticated, market closed, or
  // the dynamic subscription has drifted), live prices come from
  // the server-side Yahoo fallback enricher. That enricher runs
  // once per /api/signals call — if we don't re-fetch, Yahoo
  // numbers freeze on the client and the UI looks like it has
  // stopped updating.
  //
  // Strategy: every 15s, check whether the WS is actively
  // pushing fresh frames (wsLastAt within the last 10s AND
  // wsPrices has content). If it is → do nothing, the push
  // channel is already driving the UI. If it isn't → fire a
  // light /api/signals refresh so Yahoo LTPs re-bake on the
  // server and flow back into `sig.livePrice`.
  //
  // Skip entirely if the page is hidden (background tab).
  useEffect(() => {
    const FALLBACK_POLL_MS = 10_000;
    const WS_ACTIVE_WINDOW_MS = 10_000;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      // New short-circuit (Sep 2026 perf pass): if the SSE stream
      // is delivering frames, skip the fallback poll entirely — the
      // stream is already pushing a refresh every 5s. Without this
      // guard, a connected dashboard runs BOTH the 5s SSE push AND
      // the 10s polling reload, doubling the server's enrichment
      // work per open tab.
      const sseActive =
        stream.connected &&
        stream.lastPushAt != null &&
        Date.now() - stream.lastPushAt <= 15_000;
      if (sseActive) return;

      const marketClosed =
        kiteStatus?.marketIsOpen === false ||
        freshness?.market_open === false;
      if (marketClosed) return;

      const wsIsActive =
        wsConnected &&
        wsPrices.size > 0 &&
        wsLastAt != null &&
        Date.now() - wsLastAt <= WS_ACTIVE_WINDOW_MS;
      if (wsIsActive) return;
      // Light reload — no spinner, no pipeline trigger. Just
      // re-reads the DB rows and re-runs the live-price enricher
      // (Kite tick cache → Yahoo fallback).
      load({ spinner: false, heavy: false });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, wsLastAt, wsPrices, kiteStatus, freshness, stream.connected, stream.lastPushAt]);

  // Kite status polling + OAuth login removed — signal-only mode.

  // Stale-signal auto-refresh. Reads the freshness object written
  // by the just-completed heavy load(); if it's missing or the
  // newest signal is more than 15 minutes old while the market is
  // open, kicks the pipeline and re-reads. Silent — pipelineRunning
  // stays false so the Run button remains clickable, and the user
  // doesn't see a spinner. Fires at most once per page load.
  const autoRefreshIfStale = async () => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    // Snapshot current freshness. The `freshness` state may not
    // have committed yet when this function runs (setState is async),
    // so we re-fetch /api/signals once to read the authoritative age.
    let ageMin: number | null = null;
    let marketOpen = true;
    try {
      const r = await fetch('/api/signals?action=all&limit=1&forceRefresh=false', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        ageMin     = j?.freshness?.signal_age_minutes ?? null;
        marketOpen = j?.freshness?.market_open !== false;
      }
    } catch { /* fall through — if we can't read, don't auto-run */ }

    if (ageMin == null || ageMin <= 15 || !marketOpen) {
      pushLog(`[AUTO] signals fresh (age=${ageMin ?? '?'}m, market_open=${marketOpen}) — skipping auto-run`);
      return;
    }

    pushLog(`[AUTO] signals stale (age=${ageMin}m) — auto-running pipeline in background`);
    try {
      const res = await fetch('/api/run-signal-engine', { method: 'POST' });
      if (!res.ok) {
        pushLog(`[AUTO] pipeline POST returned ${res.status} — skipping reload`);
        return;
      }
      await load({ spinner: false, heavy: true });
      pushLog('[AUTO] background pipeline complete — UI reloaded');
    } catch (e: any) {
      pushLog(`[AUTO] background pipeline failed: ${e?.message ?? e}`);
    }
  };

  const runPipeline = async () => {
    setPipelineRunning(true);
    pushLog('[PIPELINE] POST /api/run-signal-engine — running…');
    const t0 = Date.now();
    try {
      const res = await fetch('/api/run-signal-engine', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        pushLog(
          `[PIPELINE] done  ${Date.now() - t0}ms  ` +
          `scanned=${data.total_scanned ?? '?'} approved=${data.total_approved ?? '?'} rejected=${data.total_rejected ?? '?'}  ` +
          `engine=${data.engine?.path ?? '?'}`
        );
      } else {
        pushLog(`[PIPELINE] FAILED ${res.status} ${data?.error ?? ''} ${data?.details ?? ''}`);
      }
      await load({ spinner: false, heavy: false });
    } catch (e: any) {
      pushLog(`[PIPELINE] FAILED ${e?.message ?? e}`);
    }
    finally { setPipelineRunning(false); }
  };

  const handleSearch = (q: string) => {
    setQuery(q);
    clearTimeout(timerRef.current);
    if (q.length < 2) { setSrResult(null); return; }
    timerRef.current = setTimeout(async () => {
      setSrLoad(true);
      try {
        const clean = q.trim().replace(/\s+/g, '').toUpperCase();
        const res = await fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(clean)}`);
        setSrResult(res.ok ? await res.json() : null);
      } catch { setSrResult(null); }
      finally { setSrLoad(false); }
    }, 600);
  };

  // ── ROWS = REAL PIPELINE SIGNALS ONLY (NO PADDING) ─────────────
  // Whatever the pipeline returns is what the table shows. 50
  // signals in → 50 rows out. Every drop is accounted for in the
  // counters so "API returned 50 but UI shows 49" becomes visible
  // in the console instead of silent.
  //
  // Direction normalisation (fix for "UI shows SELL = 0 but API
  // logs show SELL > 0"): the tab filter below does strict equality
  // `r.direction === 'BUY'`. If any row arrives with 'buy' (lower
  // case), ' BUY ' (whitespace), or similar, strict equality drops
  // it from BOTH tabs silently — it's not missing from the API,
  // it just doesn't match either filter. Uppercase+trim once here
  // and every downstream consumer (tabs, counts, SignalChip, row
  // background) sees a canonical 'BUY' / 'SELL' / ''.
  const bySymbol = new Map<string, SignalRow>();
  let droppedNoSymbol   = 0;
  let droppedDuplicate  = 0;
  let droppedUnknownDir = 0;

  for (const s of signals) {
    const sym = (s.tradingsymbol ?? '').toUpperCase();
    if (!sym) { droppedNoSymbol++; continue; }

    if (!s.direction) droppedUnknownDir++;

    const normalizedDir = String(s.direction ?? '').toUpperCase().trim();
    const normalized: SignalRow = { ...s, direction: normalizedDir };

    const existing = bySymbol.get(sym);
    if (!existing) { bySymbol.set(sym, normalized); continue; }
    // Same symbol arrived twice (shouldn't happen — server-side
    // dedupe prevents it — but defensive). Keep the newer row.
    droppedDuplicate++;
    const ta = new Date(s.generated_at || 0).getTime();
    const tb = new Date(existing.generated_at || 0).getTime();
    if (ta >= tb) bySymbol.set(sym, normalized);
  }

  // Drop diagnostics — fires only when at least one row was lost
  // vs what the API sent, so the console stays quiet on the happy
  // path and loud on the divergence.
  if (typeof window !== 'undefined' && bySymbol.size !== signals.length) {
    const sigKey = `${signals.length}->${bySymbol.size}|nosym=${droppedNoSymbol}|dup=${droppedDuplicate}|nodir=${droppedUnknownDir}`;
    if ((window as any).__Q365_DROP_SIG__ !== sigKey) {
      (window as any).__Q365_DROP_SIG__ = sigKey;
      console.log('[API SIGNAL COUNT]', signals.length, '→ rendered rows:', bySymbol.size);
      console.log('[UI DROPS]', {
        api_count:      signals.length,
        rendered_count: bySymbol.size,
        dropped_no_symbol:  droppedNoSymbol,
        dropped_duplicate:  droppedDuplicate,
        rows_missing_direction: droppedUnknownDir,
      });
    }
  }

  // Live-price binding — WebSocket is the ONLY source.
  //
  //   1. Lookup `wsPrices.get(normalizedSymbol)`. The streamServer
  //      publishes Kite-sourced frames (and never lets Yahoo clobber
  //      a Kite entry — see streamServer.ts), so a hit here is the
  //      authoritative LTP.
  //
  //   2. Freshness gate:
  //        market OPEN  → require tick age ≤ 30s. Otherwise the feed
  //                       has stalled for this symbol; render '—'
  //                       rather than a value old enough to mislead.
  //        market CLOSED → no age check. The WS snapshot IS the last
  //                       traded price; that's exactly what we want
  //                       to display off-hours (matches Google).
  //
  //   3. Miss → livePrice = null. The UI renders '—'. We DELIBERATELY
  //      do NOT fall back to `sig.livePrice` (server Yahoo enrichment)
  //      or `sig.ltp` / `sig.entry_price` (frozen entry snapshot) —
  //      both would make the Live column collapse onto the Entry
  //      column whenever Yahoo's value happens to equal the frozen
  //      entry price, which is the symptom operators have been hitting.
  //
  // Symbol normalisation: the WS payload uses bare tradingsymbols
  // ("LUPIN"). Some server paths pass through "NSE:LUPIN". We strip
  // any "NSE:" / "BSE:" / exchange prefix before the Map lookup so
  // a mismatch never produces a silent null.
  const WS_FRESH_MS = 30_000;
  const nowMs = Date.now();
  const normaliseSym = (raw: string): string =>
    raw.trim().toUpperCase().replace(/^(NSE|BSE|NFO|MCX):/, '');

  // Once-per-render sanity log for the first row — proves the Map
  // lookup is finding an entry. If this logs `live=undefined` but
  // `wsPrices.size > 0`, the symbol keys don't match.
  if (typeof window !== 'undefined' && bySymbol.size > 0) {
    const firstSig = bySymbol.values().next().value;
    if (firstSig) {
      const sym = normaliseSym(firstSig.tradingsymbol);
      const live = wsPrices.get(sym);
      const sigKey = `${sym}|${wsPrices.size}|${live?.ts ?? 0}`;
      if ((window as any).__Q365_LIVE_PROBE__ !== sigKey) {
        (window as any).__Q365_LIVE_PROBE__ = sigKey;
        // eslint-disable-next-line no-console
        console.log('[LIVE PRICE]', sym, live, 'mapSize=', wsPrices.size, 'marketOpen=', wsMarketOpen);
      }
    }
  }

  const signalRows: SignalRow[] = Array.from(bySymbol.values()).map((sig) => {
    const sym  = normaliseSym(sig.tradingsymbol);
    const live = wsPrices.get(sym) ?? null;

    // Accept the WS frame if market is closed (last traded price is
    // exactly what we want off-hours) OR if it's within WS_FRESH_MS.
    const wsAge  = live?.ts ? nowMs - live.ts : null;
    const accept =
      live != null &&
      live.price != null &&
      live.price > 0 &&
      (!wsMarketOpen || (wsAge != null && wsAge <= WS_FRESH_MS));

    if (accept && live) {
      // Day-change percent is derived in priority order:
      //
      //   1. (price - previous_close) / previous_close × 100
      //      The authoritative formula. Uses Kite's ohlc.close which
      //      is the previous trading day's close — same reference
      //      Google / Zerodha Kite / Groww all display against. Guard
      //      against close==price (can happen on the very last tick
      //      of a session where Kite echoes today's close into the
      //      close field) so we don't publish a bogus 0.00%.
      //
      //   2. Fall back to the frame's own pChange when the formula
      //      is unusable (no close, or close==price edge case) AND
      //      the frame's pChange is a real non-zero number.
      //
      //   3. When market is closed and we still have nothing, fall
      //      back to sig.pct_change — the day-change snapshot at
      //      signal generation. For a Friday-afternoon signal this
      //      is within minutes of Google's "previous close" reference
      //      and keeps the column from displaying a misleading 0.00%
      //      over the weekend.
      //
      //   4. Otherwise null → LiveCell renders no percent row at all.
      const prevClose = live.close ?? null;
      const priceOk   = live.price != null && live.price > 0;
      let livePChange: number | null = null;
      if (priceOk && prevClose != null && prevClose > 0 && prevClose !== live.price) {
        livePChange = ((live.price! - prevClose) / prevClose) * 100;
      } else if (live.pChange != null && live.pChange !== 0) {
        livePChange = live.pChange;
      } else if (!wsMarketOpen && typeof sig.pct_change === 'number') {
        livePChange = sig.pct_change;
      }
      return {
        ...sig,
        livePrice:   live.price,
        livePChange,
        // Honour the per-frame source from the stream server — it's
        // 'kite' for real Kite frames and 'yahoo' only for symbols
        // that have never been Kite-observed (the streamServer
        // guarantees Yahoo never overwrites a Kite entry).
        liveSource:  live.source ?? 'yahoo',
        liveTickTs:  live.ts ?? null,
      };
    }

    // No WS entry for this symbol — but the server may have enriched
    // sig.livePrice via Yahoo (see enrichWithLiveLtp in the signals
    // API). Fall back to it ONLY when the server has marked the source
    // explicitly as 'yahoo' (or 'kite' for the EOD-bar path). This is
    // the safe version of the fallback that used to be blanket-banned:
    //
    //   Historical bug: blindly rendering sig.livePrice would make the
    //   Live column collapse onto Entry when Yahoo's delayed value
    //   coincidentally matched entry_price. Operators reported this
    //   as "Live always equals Entry — column is broken".
    //
    //   Guardrails here:
    //     1. Require liveSource ∈ {'yahoo', 'kite'}. A null/undefined
    //        source means the server didn't confidently resolve a
    //        price — don't render stale junk.
    //     2. Require livePrice > 0.
    //     3. Require livePrice !== entry_price. If the server's best
    //        guess coincides with the frozen entry, we'd still show
    //        the "broken column" symptom — rendering '—' is more
    //        honest in that specific case.
    //
    // The result: when WS is dead (Kite loginRequired), operators see
    // a delayed Yahoo price with a visible 'yahoo' source badge
    // instead of staring at a column of '—'.
    const serverLive   = typeof sig.livePrice === 'number' ? sig.livePrice : null;
    const serverSource = (sig as any).liveSource ?? null;
    const entry        = typeof sig.entry_price === 'number' ? sig.entry_price : null;
    const serverPriceAcceptable =
      serverLive != null &&
      serverLive > 0 &&
      serverSource === 'yahoo' &&
      (entry == null || serverLive !== entry);

    if (serverPriceAcceptable) {
      return {
        ...sig,
        livePrice:   serverLive,
        livePChange: typeof (sig as any).livePChange === 'number' ? (sig as any).livePChange : null,
        liveSource:  serverSource, // 'yahoo' — only source in signal-only mode
        liveTickTs:  (sig as any).liveTickTs ?? null,
      };
    }

    // Still nothing usable → render '—'. Never leak sig.ltp or
    // sig.entry_price into the Live column — that's the original
    // "Live == Entry" bug this branch exists to prevent.
    return {
      ...sig,
      livePrice:   null,
      livePChange: null,
      liveSource:  null,
      liveTickTs:  null,
    };
  });

  const universeExtras: SignalRow[] = []; // never populated — kept for shape compat
  const validRows   = signalRows;
  const buySignals  = signalRows.filter(r => r.direction === 'BUY');
  const sellSignals = signalRows.filter(r => r.direction === 'SELL');
  const shown = tab === 'BUY'  ? buySignals
              : tab === 'SELL' ? sellSignals
              : validRows;

  // Pipeline visibility log — fires every render but cheap.
  if (typeof window !== 'undefined') {
    (window as any).__Q365_COUNTS__ = {
      ws_connected: wsConnected,
      ws_universe:  wsPrices.size,
      signals:      signalRows.length,
      extras:       universeExtras.length,
      valid_rows:   validRows.length,
      buy:          buySignals.length,
      sell:         sellSignals.length,
      tab,
      shown:        shown.length,
    };
    // Render-counter log — gated on a count signature so it fires
    // only when something actually changed.
    const sig = `${validRows.length}`;
    if ((window as any).__Q365_LAST_SIG__ !== sig) {
      (window as any).__Q365_LAST_SIG__ = sig;
      console.log('[UI COUNTS]', {
        signals: validRows.length,
        shown:   validRows.length,
      });
    }
  }

  return (
    <AppShell title="Signal Engine">
      {/* SSE-driven row animations. `sig-row-new` fires when a
          signal enters the top-50 for the first time. `sig-row-updated`
          fires when an existing row's final_score changed in the last
          push. Both are scoped to the <tr>, so the whole row briefly
          tints — easier to spot on a busy dashboard than cell-level
          pulses. */}
      <style jsx global>{`
        @keyframes sigRowFlashNew {
          0%   { background-color: rgba(34, 197, 94, 0.28); }
          100% { background-color: transparent; }
        }
        @keyframes sigRowFlashUpdate {
          0%   { background-color: rgba(253, 224, 71, 0.35); }
          100% { background-color: transparent; }
        }
        tr.sig-row-new    { animation: sigRowFlashNew 1.2s ease; }
        tr.sig-row-updated { animation: sigRowFlashUpdate 0.8s ease; }

        @keyframes sigLivePulse {
          0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
          70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0);   }
          100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);     }
        }
        .sig-live-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #16a34a;
          animation: sigLivePulse 2s infinite;
        }
        .sig-live-dot--off {
          background: #94a3b8;
          animation: none;
        }
      `}</style>
      <div className="page">
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Zap size={22} color="#2E75B6" /> Signal Engine
            </h1>
            <p style={{ color: '#64748B', fontSize: 14, marginTop: 4 }}>
              All signals from centralized pipeline — BUY/SELL with full analysis
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <div
              title={stream.connected ? `Live stream active · last push ${stream.lastPushAt ? new Date(stream.lastPushAt).toLocaleTimeString() : '—'}` : 'Stream reconnecting…'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', background: '#F0FDF4', borderRadius: 8,
                border: stream.connected ? '1px solid #BBF7D0' : '1px solid #FECACA',
              }}
            >
              <span className={stream.connected ? 'sig-live-dot' : 'sig-live-dot sig-live-dot--off'} />
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: stream.connected ? '#15803D' : '#991B1B' }}>
                {stream.connected ? 'LIVE' : 'OFFLINE'}
              </span>
            </div>
            <div style={{ textAlign: 'center', background: '#EFF6FF', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1D4ED8' }}>{validRows.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>TOTAL</div>
            </div>
            <div style={{ textAlign: 'center', background: '#F0FDF4', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#16A34A' }}>{buySignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>BUY</div>
            </div>
            <div style={{ textAlign: 'center', background: '#FEF2F2', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#DC2626' }}>{sellSignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>SELL</div>
            </div>
            <button
              className="btn btn--primary btn--sm"
              onClick={runPipeline}
              disabled={pipelineRunning}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <RefreshCw size={13} className={pipelineRunning ? 'spin' : ''} />
              {pipelineRunning ? 'Running…' : 'Run Pipeline'}
            </button>
          </div>
        </div>

        {/* ── Live / delayed-mode banner ─────────────────────────
            Honest about the data state:
              • market CLOSED                → amber "Last close (Yahoo)" banner
              • market OPEN + kite connected → green "Live (Kite)" strip
              • market OPEN + kite offline   → red "Delayed — Yahoo fallback" strip
            Also shows the last-tick wall clock in IST and a tri-state
            dot based on tick age:
              🟢 <3s (fresh)   🟠 3–30s (aging)   🔴 >30s (stale)
            The banner is purely presentational; the server always
            serves the best available price. */}
        {(() => {
          // Determine market-open state from whichever source
          // actually has data. `kiteStatus` usually arrives first
          // (5s poll cadence, no DB reads) so prefer it. Only fall
          // back to `freshness` if the status poll hasn't landed.
          // The previous `freshness?.market_open !== false` check
          // returned `true` when freshness was null — which made
          // the banner claim "Live" even when the market was
          // closed and no data had loaded yet.
          let marketOpen: boolean;
          if (typeof kiteStatus?.marketIsOpen === 'boolean') {
            marketOpen = kiteStatus.marketIsOpen;
          } else if (typeof freshness?.market_open === 'boolean') {
            marketOpen = freshness.market_open;
          } else {
            // No data yet — optimistic default, immediately
            // corrected by the first status or freshness poll.
            marketOpen = true;
          }
          const marketLabel =
            kiteStatus?.marketLabel ??
            freshness?.market_label ??
            (marketOpen ? 'Open' : 'Closed');
          // Yahoo-only mode: no tick telemetry. Tri-state dot reduced
          // to a simple "source is yahoo" indicator; age and rate are
          // not exposed by the upstream.
          const lastTickIST: string | null = null;
          const tickDot = '#F59E0B';
          const tickDotLabel = 'yahoo snapshot';

          let bg = '#FFFBEB', fg = '#92400E', border = '#FDE68A';
          let dot = '#F59E0B';
          let headline: string;
          let sub: string;
          if (!marketOpen) {
            headline = `Market ${marketLabel}`;
            sub = 'Showing last-close prices (Yahoo). No real-time ticks expected until next session.';
          } else {
            headline = 'Yahoo (delayed)';
            sub = 'Prices are ~15 min delayed. Signal-only mode — broker-independent.';
          }

          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 8,
              background: bg, color: fg, border: `1px solid ${border}`,
              marginBottom: 16, fontSize: 13,
            }}>
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: 99,
                background: dot, flexShrink: 0,
              }} />
              <div style={{ flex: 1, minWidth: 260 }}>
                <strong>{headline}</strong>
                <span style={{ opacity: 0.85, marginLeft: 8 }}>{sub}</span>
              </div>
              {/* IST wall clock + tri-state freshness dot — always
                  rendered so the operator can verify the feed at a
                  glance. When the market is closed or no tick has
                  arrived yet, the dot goes grey with "no ticks". */}
              <div
                title={`tick age: ${tickDotLabel}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px 10px', borderRadius: 99,
                  background: 'rgba(255,255,255,0.55)',
                  border: `1px solid ${border}`,
                  fontSize: 12, fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 99,
                  background: tickDot, flexShrink: 0,
                }} />
                <span>Last Tick: {lastTickIST ?? '—'}</span>
              </div>
            </div>
          );
        })()}

        {/* ── Deep signal lookup ── */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
            <Search size={16} color="#94A3B8" style={{ flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Deep analysis: type any equity symbol (e.g. RELIANCE, TCS, HDFC)…"
              value={query}
              onChange={e => handleSearch(e.target.value)}
              style={{ height: 44 }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', paddingLeft: 26 }}>
            Runs full signal engine live — factor scoring, confidence, R:R levels, rejection analysis
          </div>
          {srLoading && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Activity size={13} /> Analysing {query.toUpperCase()}…
            </div>
          )}
          {srResult && !srLoading && <SearchResult data={srResult} symbol={query.toUpperCase()} />}
        </Card>

        {/* ── Diagnostic strip — signal-only / Yahoo mode ── */}
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          padding: '8px 12px', marginBottom: 12, borderRadius: 8,
          background: '#FFFBEB',
          border: '1px solid #FDE68A',
          fontSize: 11, fontWeight: 600, color: '#334155',
        }}>
          <span>MODE: <strong style={{
            color:
              wsMode === 'YAHOO_FALLBACK' ? '#D97706' :
              wsMode === 'MARKET_CLOSED'  ? '#64748B' :
              wsMode === 'WAITING'        ? '#D97706' :
                                            '#DC2626',
          }}>{
            wsMode === 'YAHOO_FALLBACK' ? 'YAHOO' :
            wsMode === 'MARKET_CLOSED'  ? `MARKET CLOSED — ${wsMarketLabel}` :
            wsMode === 'WAITING'        ? 'WAITING' :
                                          'DISCONNECTED'
          }</strong></span>
          <span>·</span>
          <span>SIGNALS: <strong>{validRows.length}</strong></span>
          <span>·</span>
          <span>SHOWN: <strong>{validRows.length}</strong></span>
          <span>·</span>
          <span>BUY: <strong>{buySignals.length}</strong></span>
          <span>·</span>
          <span>SELL: <strong>{sellSignals.length}</strong></span>
          <span>·</span>
          <span>TAB: <strong>{tab}</strong></span>
          <span>·</span>
          <span>SHOWN: <strong>{shown.length}</strong></span>
        </div>

        {/* ── Tab selector ── */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['ALL', 'BUY', 'SELL'] as const).map(t => (
            <button key={t}
              className={`btn btn--sm ${tab === t ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setTab(t)}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {t === 'BUY' && <TrendingUp size={13} />}
              {t === 'SELL' && <TrendingDown size={13} />}
              {t} ({t === 'ALL' ? validRows.length : t === 'BUY' ? buySignals.length : sellSignals.length})
            </button>
          ))}
        </div>

        {/* ── Signal table (ALL merges in live stocks as synthetic rows) ── */}
        <Card flush>
          {!wsConnected && !loading && (
            <div style={{
              padding: '8px 14px',
              background: '#FEF9C3',
              color: '#A16207',
              fontSize: 12,
              fontWeight: 600,
              borderBottom: '1px solid #FDE68A',
            }}>
              Connecting to live market data… rows will update as the stream warms up.
            </div>
          )}
          {loading ? (
            <div style={{ padding: 32 }}><Loading text="Loading signals from database…" /></div>
          ) : shown.length === 0 ? (
            <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>
              <Zap size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No signals in database</div>
              <div style={{ fontSize: 13, marginBottom: 12 }}>Click "Run Pipeline" to generate fresh signals</div>
              <button className="btn btn--primary btn--sm" onClick={runPipeline} disabled={pipelineRunning}>
                <Zap size={13} /> Generate Signals
              </button>
            </div>
          ) : (
            <div style={{ overflow: 'auto', maxHeight: 720 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['#', 'Symbol', 'Direction', 'Strategy', 'Confidence', 'Entry', 'Stop Loss', 'Target', 'R:R', 'Opp Score', 'Conviction', ''].map(h => (
                      <th key={h} style={{
                        padding: '9px 12px',
                        textAlign: ['Entry', 'Stop Loss', 'Target', 'R:R', 'Opp Score'].includes(h) ? 'right' : 'left',
                        fontSize: 10, color: '#94A3B8', fontWeight: 700, whiteSpace: 'nowrap',
                        background: '#F8FAFC',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s, i) => {
                    // SSE-driven animation key. Rows that the diff
                    // hook flagged as new/changed get a key that
                    // changes on every push → React remounts the
                    // <tr>, replaying the CSS keyframe. Stable rows
                    // keep a stable key so scrolling + intrinsic-
                    // size virtualisation stay cheap.
                    const isChanged = s.id != null && stream.changedIds.has(s.id);
                    const isNew     = s.id != null && stream.newIds.has(s.id);
                    const animClass = isNew ? 'sig-row-new'
                                    : isChanged ? 'sig-row-updated'
                                    : '';
                    const animKey   = (isNew || isChanged)
                      ? `${s.id}-${animClass}-${stream.lastPushAt ?? 0}`
                      : `${s.id ?? i}-stable`;
                    return (
                    <tr key={`${s.tradingsymbol}-${animKey}`}
                      className={animClass}
                      style={{
                        borderTop: '1px solid #F1F5F9',
                        background: s.direction === 'BUY' ? '#FAFFFE'
                                  : s.direction === 'SELL' ? '#FFFAFA'
                                  : '#fff',
                        contentVisibility: 'auto',
                        containIntrinsicSize: '48px',
                      } as React.CSSProperties}>
                      <td style={{ padding: '10px 12px', fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{i + 1}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ fontWeight: 800, color: '#1E3A5F', textDecoration: 'none' }}>
                          {s.tradingsymbol}
                        </Link>
                        <div style={{ fontSize: 10, color: '#94A3B8' }}>{s.exchange}</div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <SignalChip dir={s.direction} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ScenarioTag tag={s.scenario_tag} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConfBar value={s.confidence_score ?? s.confidence} />
                      </td>
                      {/* ── ENTRY (frozen at signal generation) ── */}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#1E3A5F' }}>
                        {s.ltp != null && s.ltp > 0
                          ? fmt.currency(s.ltp)
                          : s.entry_price ? fmt.currency(s.entry_price) : '—'}
                      </td>

                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>
                        {s.stop_loss ? fmt.currency(s.stop_loss) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#15803D', fontWeight: 600 }}>
                        {s.target1 ? fmt.currency(s.target1) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>
                        {s.risk_reward ? `1:${s.risk_reward}` : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        {s.opportunity_score > 0 ? (
                          <span style={{ fontWeight: 700, fontSize: 13,
                            color: s.opportunity_score >= 80 ? '#065F46' : s.opportunity_score >= 60 ? '#1D4ED8' : '#D97706' }}>
                            {s.opportunity_score}
                          </span>
                        ) : (
                          <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConvictionBadge band={s.conviction_band} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#2E75B6', textDecoration: 'none' }}>
                          <Target size={11} /> Chart <ChevronRight size={10} />
                        </Link>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div style={{ marginTop: 16, fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>
          Signals generated by centralized pipeline. Run Pipeline to refresh.
          Not investment advice.
        </div>
      </div>
    </AppShell>
  );
}
