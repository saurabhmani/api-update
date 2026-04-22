// ════════════════════════════════════════════════════════════════
//  FloatingBotIndicator — glassmorphic system-status bot
//
//  A fixed-position, zero-dep status indicator designed to sit in the
//  top-right of a trading dashboard (Zerodha / TradingView vibes).
//
//  Responsive:
//    • Desktop: full bot + text + optional counts-on-hover tooltip
//    • Mobile:  compact 48 px circle, tap to expand the label panel
//
//  Animations (all CSS, zero JS-driven frames):
//    LIVE    — green, pulsing glow, blinking eyes, subtle bounce
//    DELAYED — yellow, L→R scanning sweep, slow pulse
//    CLOSED  — grey, soft fade, no aggressive motion
//    OFFLINE — red, shake + warning blink
//
//  Integrates with useStockBot():
//    const { overall, counts, lastFetchAt } = useStockBot(symbols);
//    <FloatingBotIndicator
//      status={overall}
//      counts={counts}
//      lastUpdated={lastFetchAt}
//    />
// ════════════════════════════════════════════════════════════════

'use client';

import React, { useEffect, useMemo, useState } from 'react';

export type FloatingBotState =
  | 'LIVE'
  | 'DELAYED'
  | 'CLOSED'
  | 'STALE'
  | 'OFFLINE';

export interface FloatingBotIndicatorProps {
  status:       FloatingBotState;
  counts?:      Partial<Record<FloatingBotState, number>>;
  lastUpdated?: number | null;
  source?:      'kite' | 'yahoo' | 'none' | null;
  /** Corner positioning. Defaults to top-right. */
  position?:    'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  /** Hide on mobile — lets the caller render a different shell there. */
  hideOnMobile?: boolean;
}

const LABEL: Record<FloatingBotState, string> = {
  LIVE:    'LIVE • Kite',
  DELAYED: 'DELAYED • Yahoo',
  CLOSED:  'MARKET CLOSED',
  STALE:   'LAST CLOSE',
  OFFLINE: 'NO DATA',
};

interface Palette {
  accent: string;   // primary accent color
  ring:   string;   // pulse ring color
  chip:   string;   // status-chip background
  chipFg: string;
  eye:    string;
}

function getPalette(s: FloatingBotState): Palette {
  switch (s) {
    case 'LIVE':    return { accent: '#10B981', ring: 'rgba(16,185,129,0.45)', chip: '#10B981', chipFg: '#fff',     eye: '#065F46' };
    case 'DELAYED': return { accent: '#F59E0B', ring: 'rgba(245,158,11,0.40)', chip: '#F59E0B', chipFg: '#fff',     eye: '#92400E' };
    case 'CLOSED':
    case 'STALE':   return { accent: '#94A3B8', ring: 'rgba(148,163,184,0.30)', chip: '#E2E8F0', chipFg: '#334155', eye: '#475569' };
    case 'OFFLINE': return { accent: '#EF4444', ring: 'rgba(239,68,68,0.35)',  chip: '#EF4444', chipFg: '#fff',     eye: '#7F1D1D' };
  }
}

function formatAgo(tsMs: number | null | undefined, nowMs: number): string {
  if (!tsMs) return 'not yet';
  const diff = Math.max(0, nowMs - tsMs);
  if (diff < 1_000)      return 'just now';
  if (diff < 60_000)     return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

export default function FloatingBotIndicator({
  status,
  counts,
  lastUpdated,
  source,
  position    = 'top-right',
  hideOnMobile = false,
}: FloatingBotIndicatorProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [now,      setNow]      = useState(() => Date.now());
  const [hovering, setHovering] = useState(false);

  // 1 Hz clock drives the "updated Xs ago" string. One setState per
  // tab per second — cheap. We don't use rAF here because nothing
  // is visually animating at pixel-level; CSS handles the rest.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const palette = useMemo(() => getPalette(status), [status]);
  const label   = LABEL[status];
  const agoStr  = formatAgo(lastUpdated, now);
  const srcBadge = source === 'kite' ? 'K' : source === 'yahoo' ? 'Y' : null;

  // Counts for the hover tooltip — hide entries with zero.
  const countItems: Array<[FloatingBotState, number]> = [];
  if (counts) {
    (['LIVE', 'DELAYED', 'CLOSED', 'STALE', 'OFFLINE'] as FloatingBotState[])
      .forEach((k) => {
        const n = counts[k] ?? 0;
        if (n > 0) countItems.push([k, n]);
      });
  }

  const showTooltip = hovering && countItems.length > 0;
  const wrapCls = [
    'floating-bot',
    `pos-${position}`,
    `state-${status.toLowerCase()}`,
    expanded   ? 'expanded'  : '',
    hideOnMobile ? 'hide-mobile' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={wrapCls}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={() => setExpanded((v) => !v)}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <div className="glass">
        <div className="botWrap">
          <span className="ring" aria-hidden />
          <svg viewBox="0 0 44 44" className="bot" aria-hidden>
            {/* antenna */}
            <line x1="22" y1="8" x2="22" y2="3"
                  stroke={palette.accent} strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="22" cy="2.2" r="2.2" fill={palette.accent} className="antennaDot" />
            {/* head */}
            <rect x="7" y="9" width="30" height="23" rx="7" ry="7"
                  fill="#fff" stroke={palette.accent} strokeWidth="1.8" className="head" />
            {/* eyes */}
            <ellipse cx="16" cy="20" rx="2.6" ry="3" fill={palette.eye}  className="eye" />
            <ellipse cx="28" cy="20" rx="2.6" ry="3" fill={palette.eye}  className="eye" />
            {/* mouth / scan bar */}
            <rect x="14" y="26" width="16" height="1.8" rx="0.9"
                  fill={palette.accent} className="mouth" />
            {/* base */}
            <rect x="11" y="32" width="22" height="4" rx="1.6" fill="#E2E8F0" />
            {/* scan line (visible in DELAYED) */}
            <rect x="8" y="10" width="2" height="20" rx="1" fill={palette.accent}
                  className="scanLine" opacity="0" />
          </svg>
        </div>

        <div className="meta">
          <div className="labelRow">
            <span className="statusChip">{label}</span>
            {srcBadge && <span className="srcBadge">{srcBadge}</span>}
          </div>
          <div className="ago">updated {agoStr}</div>
        </div>
      </div>

      {showTooltip && (
        <div className="tooltip">
          <div className="ttTitle">System state</div>
          <div className="ttGrid">
            {countItems.map(([k, n]) => (
              <div className="ttRow" key={k}>
                <span className={`ttDot state-dot-${k.toLowerCase()}`} />
                <span className="ttK">{k}</span>
                <span className="ttN">{n}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─────────────── STYLES ─────────────── */}
      <style jsx>{`
        /* ── Container ─────────────────────────────────────────── */
        .floating-bot {
          position: fixed;
          z-index: 9999;
          user-select: none;
          cursor: pointer;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
          color: #0F172A;
          -webkit-tap-highlight-color: transparent;
        }
        .pos-top-right    { top: 16px;    right: 16px;  }
        .pos-top-left     { top: 16px;    left: 16px;   }
        .pos-bottom-right { bottom: 16px; right: 16px;  }
        .pos-bottom-left  { bottom: 16px; left: 16px;   }

        /* ── Glassmorphic shell ───────────────────────────────── */
        .glass {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 14px 10px 10px;
          background: rgba(255, 255, 255, 0.72);
          -webkit-backdrop-filter: blur(14px) saturate(180%);
          backdrop-filter: blur(14px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.55);
          border-radius: 14px;
          box-shadow:
            0 10px 32px rgba(15, 23, 42, 0.12),
            0 2px 6px rgba(15, 23, 42, 0.06),
            inset 0 1px 0 rgba(255, 255, 255, 0.9);
          transition:
            transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
            box-shadow 280ms ease,
            background 280ms ease;
        }
        .floating-bot:hover .glass {
          transform: translateY(-2px);
          box-shadow:
            0 16px 40px rgba(15, 23, 42, 0.16),
            0 4px 10px rgba(15, 23, 42, 0.08);
        }
        .floating-bot:active .glass { transform: translateY(0); }

        /* ── Bot housing ──────────────────────────────────────── */
        .botWrap {
          position: relative;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .bot {
          width: 100%;
          height: 100%;
          display: block;
          overflow: visible;
        }
        .ring {
          position: absolute;
          inset: -6px;
          border-radius: 50%;
          background: radial-gradient(closest-side, ${palette.ring}, transparent 70%);
          pointer-events: none;
        }

        /* ── Meta text ────────────────────────────────────────── */
        .meta {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .labelRow {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .statusChip {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.6px;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 999px;
          background: ${palette.chip};
          color: ${palette.chipFg};
          white-space: nowrap;
          transition: background 280ms ease, color 280ms ease;
        }
        .srcBadge {
          font-size: 9px;
          font-weight: 800;
          padding: 2px 5px;
          border-radius: 4px;
          background: rgba(15, 23, 42, 0.08);
          color: #475569;
          letter-spacing: 0.3px;
        }
        .ago {
          font-size: 10px;
          color: #64748B;
          letter-spacing: 0.2px;
          font-variant-numeric: tabular-nums;
        }

        /* ── Tooltip (desktop hover) ──────────────────────────── */
        .tooltip {
          position: absolute;
          top: calc(100% + 8px);
          right: 0;
          min-width: 140px;
          padding: 10px 12px;
          background: rgba(15, 23, 42, 0.94);
          color: #F1F5F9;
          border-radius: 10px;
          box-shadow: 0 12px 36px rgba(15, 23, 42, 0.25);
          animation: tooltipIn 180ms ease-out;
          pointer-events: none;
          font-size: 11px;
        }
        .pos-bottom-right .tooltip,
        .pos-bottom-left .tooltip {
          top: auto;
          bottom: calc(100% + 8px);
        }
        .pos-top-left .tooltip,
        .pos-bottom-left .tooltip {
          right: auto;
          left: 0;
        }
        .ttTitle {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1px;
          color: #94A3B8;
          text-transform: uppercase;
          margin-bottom: 6px;
        }
        .ttGrid { display: flex; flex-direction: column; gap: 4px; }
        .ttRow  {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
        }
        .ttDot {
          width: 7px; height: 7px; border-radius: 50%;
          flex-shrink: 0;
        }
        .state-dot-live    { background: #10B981; box-shadow: 0 0 6px #10B981; }
        .state-dot-delayed { background: #F59E0B; box-shadow: 0 0 6px #F59E0B; }
        .state-dot-closed,
        .state-dot-stale   { background: #94A3B8; }
        .state-dot-offline { background: #EF4444; box-shadow: 0 0 6px #EF4444; }
        .ttK { flex: 1; color: #CBD5E1; font-weight: 600; letter-spacing: 0.3px; }
        .ttN { color: #F8FAFC; font-weight: 700; font-variant-numeric: tabular-nums; }

        @keyframes tooltipIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0);    }
        }

        /* ── LIVE — pulsing glow, blinking eyes, subtle bounce ── */
        .state-live .ring { animation: ringPulse 1.6s ease-out infinite; }
        .state-live .bot  { animation: bounce 2.2s ease-in-out infinite; }
        .state-live .eye  { animation: blink 3.2s infinite; transform-origin: center; transform-box: fill-box; }
        .state-live .antennaDot { animation: pulseDot 1.4s ease-in-out infinite; }
        .state-live .mouth  { animation: mouthBreathe 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        .state-live .head   { filter: drop-shadow(0 0 6px rgba(16,185,129,0.35)); }

        /* ── DELAYED — scanning sweep + slow pulse ─────────── */
        .state-delayed .ring { animation: ringPulseSlow 2.4s ease-in-out infinite; }
        .state-delayed .scanLine { animation: scanSweep 2s ease-in-out infinite; opacity: 0.7; }
        .state-delayed .antennaDot { animation: pulseDot 2s ease-in-out infinite; }
        .state-delayed .mouth  { animation: mouthScan 2s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }

        /* ── CLOSED / STALE — soft idle, no loud motion ────── */
        .state-closed .eye,
        .state-stale  .eye  { animation: sleepyBlink 4.5s infinite; transform-origin: center; transform-box: fill-box; }
        .state-closed .glass,
        .state-stale  .glass { animation: idleFade 6s ease-in-out infinite; }

        /* ── OFFLINE — shake + warning blink ──────────────── */
        .state-offline .bot  { animation: shake 0.5s ease-in-out infinite; }
        .state-offline .ring { animation: warningBlink 0.9s ease-in-out infinite; }
        .state-offline .eye  { transform: scaleY(0.25); }

        /* ── Keyframes ────────────────────────────────────── */
        @keyframes ringPulse {
          0%   { opacity: 0.9; transform: scale(1);    }
          70%  { opacity: 0;   transform: scale(1.45); }
          100% { opacity: 0;   transform: scale(1.45); }
        }
        @keyframes ringPulseSlow {
          0%, 100% { opacity: 0.35; transform: scale(1);    }
          50%      { opacity: 0.70; transform: scale(1.15); }
        }
        @keyframes bounce {
          0%, 100% { transform: translateY(0);    }
          50%      { transform: translateY(-1.5px); }
        }
        @keyframes blink {
          0%, 92%, 100% { transform: scaleY(1);    }
          94%, 98%      { transform: scaleY(0.1);  }
        }
        @keyframes sleepyBlink {
          0%, 100% { transform: scaleY(0.5);  }
          50%      { transform: scaleY(0.12); }
        }
        @keyframes pulseDot {
          0%, 100% { opacity: 1;   transform: scale(1);   }
          50%      { opacity: 0.55; transform: scale(0.8); }
        }
        @keyframes mouthBreathe {
          0%, 100% { transform: scaleX(1);    opacity: 0.8; }
          50%      { transform: scaleX(1.15); opacity: 1;   }
        }
        @keyframes mouthScan {
          0%   { transform: translateX(-2px); }
          50%  { transform: translateX(2px);  }
          100% { transform: translateX(-2px); }
        }
        @keyframes scanSweep {
          0%   { transform: translateX(0);   opacity: 0;   }
          15%  { opacity: 0.8; }
          85%  { opacity: 0.8; }
          100% { transform: translateX(28px); opacity: 0;  }
        }
        @keyframes idleFade {
          0%, 100% { opacity: 0.92; }
          50%      { opacity: 1;    }
        }
        @keyframes shake {
          0%, 100% { transform: translateX(0);    }
          20%      { transform: translateX(-1.4px); }
          40%      { transform: translateX(1.4px);  }
          60%      { transform: translateX(-1.2px); }
          80%      { transform: translateX(1.2px);  }
        }
        @keyframes warningBlink {
          0%, 100% { opacity: 0.25; }
          50%      { opacity: 0.75; }
        }

        /* ── Responsive: compact on mobile ────────────────── */
        @media (max-width: 640px) {
          .hide-mobile { display: none; }

          .floating-bot { top: 12px; right: 12px; }
          .pos-bottom-right { bottom: 12px; right: 12px; top: auto; }
          .pos-bottom-left  { bottom: 12px; left:  12px; top: auto; }
          .pos-top-left     { left:  12px; top:   12px; right: auto; }

          .glass {
            padding: 6px;
            gap: 0;
            border-radius: 999px;
          }
          .botWrap { width: 36px; height: 36px; }

          /* Compact: hide meta; tap to expand */
          .meta { display: none; }

          .floating-bot.expanded .glass {
            padding: 8px 14px 8px 8px;
            gap: 10px;
            border-radius: 14px;
          }
          .floating-bot.expanded .meta {
            display: flex;
            animation: slideIn 220ms cubic-bezier(0.22, 1, 0.36, 1);
          }
          .tooltip { display: none; }
        }

        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-8px); }
          to   { opacity: 1; transform: translateX(0);    }
        }

        /* ── Respect reduced-motion preference ────────────── */
        @media (prefers-reduced-motion: reduce) {
          .ring, .bot, .eye, .antennaDot, .mouth, .scanLine, .glass {
            animation: none !important;
          }
        }

        /* ── Dark-mode friendly glass ─────────────────────── */
        @media (prefers-color-scheme: dark) {
          .floating-bot { color: #F1F5F9; }
          .glass {
            background: rgba(15, 23, 42, 0.65);
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow:
              0 10px 32px rgba(0, 0, 0, 0.45),
              inset 0 1px 0 rgba(255, 255, 255, 0.06);
          }
          .ago { color: #94A3B8; }
          .srcBadge {
            background: rgba(255, 255, 255, 0.08);
            color: #CBD5E1;
          }
          .head { fill: #1E293B; }
        }
      `}</style>
    </div>
  );
}
