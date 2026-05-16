// ════════════════════════════════════════════════════════════════
//  BotIndicator — animated system-status bot.
//
//  Drives off the `overall` status from useStockBot():
//    LIVE    → green pulse, blinking eyes
//    DELAYED → amber scanning pulse
//    CLOSED  → grey idle (market closed)
//    OFFLINE → red jitter
//
//  Pure SVG + styled-jsx. No external CSS file. Drop anywhere.
// ════════════════════════════════════════════════════════════════

'use client';

import React from 'react';

export type BotIndicatorStatus = 'LIVE' | 'DELAYED' | 'CLOSED' | 'STALE' | 'OFFLINE';

export interface BotIndicatorProps {
  status: BotIndicatorStatus;
  size?:  number;
  label?: string;
  counts?: Partial<Record<BotIndicatorStatus, number>>;
}

const LABEL_MAP: Record<BotIndicatorStatus, string> = {
  LIVE:    'LIVE (Yahoo)',
  DELAYED: 'DELAYED (Yahoo)',
  CLOSED:  'MARKET CLOSED',
  STALE:   'LAST CLOSE',
  OFFLINE: 'NO DATA',
};

function palette(status: BotIndicatorStatus) {
  switch (status) {
    case 'LIVE':    return { bg: '#D1FAE5', stroke: '#10B981', eye: '#065F46', ring: 'rgba(34,197,94,0.45)', text: '#065F46' };
    case 'DELAYED': return { bg: '#FEF3C7', stroke: '#F59E0B', eye: '#92400E', ring: 'rgba(245,158,11,0.40)', text: '#92400E' };
    case 'CLOSED':
    case 'STALE':   return { bg: '#F1F5F9', stroke: '#94A3B8', eye: '#475569', ring: 'transparent',         text: '#475569' };
    case 'OFFLINE': return { bg: '#FEE2E2', stroke: '#EF4444', eye: '#7F1D1D', ring: 'rgba(239,68,68,0.35)', text: '#7F1D1D' };
  }
}

export default function BotIndicator({
  status,
  size   = 36,
  label,
  counts,
}: BotIndicatorProps): React.ReactElement {
  const p = palette(status);
  const displayLabel = label ?? LABEL_MAP[status];
  const cls = `bot-${status.toLowerCase()}`;
  return (
    <div className={`botWrap ${cls}`} title={displayLabel}>
      <div className="botBox" style={{ width: size, height: size }}>
        <span className="ring" aria-hidden />
        <svg viewBox="0 0 40 40" width="100%" height="100%" className="svg" aria-hidden>
          <rect x="6" y="8" width="28" height="22" rx="6" ry="6"
                fill={p.bg} stroke={p.stroke} strokeWidth="1.4" className="head" />
          <line x1="20" y1="8" x2="20" y2="3" stroke={p.stroke} strokeWidth="1.4" />
          <circle cx="20" cy="2" r="2" fill={p.stroke} className="antennaDot" />
          <circle cx="14" cy="19" r="2.4" fill={p.eye} className="eye" />
          <circle cx="26" cy="19" r="2.4" fill={p.eye} className="eye" />
          <rect x="13" y="25" width="14" height="1.6" rx="0.8" fill={p.stroke} className="mouth" />
          <rect x="10" y="30" width="20" height="4" rx="1.5" fill="#E2E8F0" />
        </svg>
      </div>
      <div className="meta">
        <span className="label" style={{ color: p.text }}>{displayLabel}</span>
        {counts && (
          <span className="counts">
            {(['LIVE','DELAYED','CLOSED','STALE','OFFLINE'] as BotIndicatorStatus[])
              .filter((k) => (counts[k] ?? 0) > 0)
              .map((k) => `${k.toLowerCase()} ${counts[k]}`)
              .join(' · ')}
          </span>
        )}
      </div>

      <style jsx>{`
        .botWrap {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          user-select: none;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .botBox {
          position: relative;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          transition: transform 220ms ease;
        }
        .botBox:hover { transform: scale(1.06); }
        .svg { display: block; }
        .ring {
          position: absolute;
          inset: -4px;
          border-radius: 12px;
          pointer-events: none;
          background: radial-gradient(closest-side, ${p.ring}, transparent 70%);
        }
        .meta {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .label {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.5px;
          text-transform: uppercase;
        }
        .counts {
          font-size: 10px;
          color: #64748B;
          letter-spacing: 0.3px;
        }

        /* ── LIVE: green pulse + blinking eyes ───────────────── */
        .bot-live .ring   { animation: pulseLive 1.4s ease-out infinite; }
        .bot-live .mouth  { animation: scan 1.8s ease-in-out infinite; transform-origin: center; }
        .bot-live .antennaDot { animation: blink 1.4s infinite; }
        .bot-live .eye    { animation: blinkEye 3s infinite; transform-origin: center; transform-box: fill-box; }

        /* ── DELAYED: amber scanning pulse ───────────────────── */
        .bot-delayed .ring  { animation: pulseDelayed 2s ease-in-out infinite; }
        .bot-delayed .mouth { animation: scanSlow 2.4s linear infinite; transform-origin: center; }

        /* ── CLOSED/STALE: grey idle ─────────────────────────── */
        .bot-closed .antennaDot,
        .bot-stale  .antennaDot { animation: blink 3s infinite; }
        .bot-closed .eye,
        .bot-stale  .eye        { animation: sleepyBlink 4s infinite; transform-origin: center; transform-box: fill-box; }

        /* ── OFFLINE: red jitter ─────────────────────────────── */
        .bot-offline .ring { animation: pulseOffline 1s ease-in-out infinite; }
        .bot-offline .head { animation: jitter 0.6s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        .bot-offline .eye  { transform: scaleY(0.2); }

        @keyframes pulseLive {
          0%   { transform: scale(1);    opacity: 0.85; }
          60%  { transform: scale(1.28); opacity: 0;    }
          100% { transform: scale(1.28); opacity: 0;    }
        }
        @keyframes pulseDelayed {
          0%, 100% { opacity: 0.35; transform: scale(1);    }
          50%      { opacity: 0.70; transform: scale(1.12); }
        }
        @keyframes pulseOffline {
          0%, 100% { opacity: 0.25; }
          50%      { opacity: 0.65; }
        }
        @keyframes blink {
          0%, 100% { opacity: 1;   }
          50%      { opacity: 0.25; }
        }
        @keyframes blinkEye {
          0%, 94%, 100% { transform: scaleY(1);    }
          96%, 98%      { transform: scaleY(0.12); }
        }
        @keyframes sleepyBlink {
          0%, 100% { transform: scaleY(0.55); }
          50%      { transform: scaleY(0.12); }
        }
        @keyframes scan {
          0%, 100% { transform: translateX(0);   opacity: 0.6; }
          50%      { transform: translateX(3px); opacity: 1;   }
        }
        @keyframes scanSlow {
          0%   { transform: translateX(-2px); }
          50%  { transform: translateX(2px);  }
          100% { transform: translateX(-2px); }
        }
        @keyframes jitter {
          0%, 100% { transform: translateX(0);   }
          25%      { transform: translateX(-1px); }
          75%      { transform: translateX(1px);  }
        }
      `}</style>
    </div>
  );
}
