'use client';

/**
 * Multi-timeframe confirmation panel — canonical explain contract.
 * Daily / 4H / 1H + overall alignment score & state.
 */

import type { CSSProperties } from 'react';

export interface MtfExplainProps {
  daily: { verdict: string; evidence: string };
  fourHour: { verdict: string; evidence: string };
  oneHour: { role: string; evidence: string };
  overall: { score: number; state: string; summary: string };
}

function verdictColour(v: string): string {
  const x = v.toLowerCase();
  if (x.includes('bull') || x === 'confirmation') return '#065F46';
  if (x.includes('bear') || x === 'conflict') return '#991B1B';
  if (x.includes('insufficient') || x === 'waiting') return '#92400E';
  return '#475569';
}

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '72px 1fr',
  gap: 8,
  fontSize: 12,
  lineHeight: 1.4,
  marginBottom: 6,
};

const labelStyle: CSSProperties = {
  fontWeight: 700,
  color: '#334155',
};

export function MultiTimeframeExplainPanel({ daily, fourHour, oneHour, overall }: MtfExplainProps) {
  return (
    <div
      style={{
        border: '1px solid #E2E8F0',
        borderRadius: 8,
        padding: '10px 12px',
        background: '#F8FAFC',
      }}
      data-testid="mtf-explain-panel"
    >
      <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8, color: '#0F172A' }}>
        Multi-timeframe confirmation
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>Daily</span>
        <span>
          <span style={{ color: verdictColour(daily.verdict), fontWeight: 700 }}>{daily.verdict}</span>
          {' — '}
          {daily.evidence}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>4H</span>
        <span>
          <span style={{ color: verdictColour(fourHour.verdict), fontWeight: 700 }}>{fourHour.verdict}</span>
          {' — '}
          {fourHour.evidence}
        </span>
      </div>
      <div style={rowStyle}>
        <span style={labelStyle}>1H</span>
        <span>
          <span style={{ color: verdictColour(oneHour.role), fontWeight: 700 }}>{oneHour.role}</span>
          {' — '}
          {oneHour.evidence}
        </span>
      </div>
      <div style={{ ...rowStyle, marginBottom: 0, marginTop: 4 }}>
        <span style={labelStyle}>Overall</span>
        <span>
          <strong>{overall.state}</strong>
          {' · score '}
          <strong>{overall.score >= 0 ? '+' : ''}{overall.score}</strong>
          {overall.summary ? ` · ${overall.summary}` : ''}
        </span>
      </div>
    </div>
  );
}
