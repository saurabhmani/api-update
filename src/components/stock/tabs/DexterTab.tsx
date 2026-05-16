'use client';
import { useEffect, useState } from 'react';
import { Loading, Empty } from '@/components/ui';
import { Brain, TrendingUp, Target, AlertTriangle, Shield, ChevronDown, ChevronUp } from 'lucide-react';

interface DexterIntel {
  symbol: string;
  verdict: string;
  conviction: string;
  explanation: { setupReason: string; newsImpact: string; cautionReason: string | null; riskHighlights: string[]; invalidators: string[] };
  modifiers: Record<string, number>;
  calibration: { strategyWinRate: number | null; strategyFit: string; confidenceCalibration: string; feedbackNote: string | null };
  guidance: string[];
}

const CONV = { high: { color: '#059669', bg: '#D1FAE5', label: 'High Conviction', Icon: TrendingUp },
  moderate: { color: '#1E40AF', bg: '#DBEAFE', label: 'Moderate', Icon: Target },
  low: { color: '#92400E', bg: '#FEF3C7', label: 'Low', Icon: AlertTriangle },
  avoid: { color: '#991B1B', bg: '#FEE2E2', label: 'Avoid', Icon: Shield } } as any;

export default function DexterTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<DexterIntel[]>([]);
  const [loading, setLoading] = useState(true);
  const [expand, setExpand] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/signal-engine/dexter?days=14&symbol=${encodeURIComponent(symbol)}`)
      .then(r => r.json())
      .then(j => setData(j.intelligence ?? []))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [symbol]);

  if (loading) return <Loading text="Loading Dexter intelligence..." />;
  if (data.length === 0) return <Empty title="No Dexter intelligence for this symbol" icon={Brain} />;

  const d = data[0]; // Most recent signal
  const c = CONV[d.conviction] ?? CONV.moderate;

  return (
    <div>
      {/* Verdict */}
      <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:16 }}>
        <c.Icon size={20} style={{ color: c.color }} />
        <span style={{ display:'inline-block', padding:'3px 12px', borderRadius:20, fontSize:11, fontWeight:700, background:c.bg, color:c.color, textTransform:'uppercase' }}>{c.label}</span>
      </div>
      <p style={{ fontSize:15, fontWeight:600, lineHeight:1.6, marginBottom:16 }}>{d.verdict}</p>

      {/* Setup Reason */}
      <div style={{ fontSize:13, color:'#2D3748', lineHeight:1.5, marginBottom:12 }}>{d.explanation.setupReason}</div>

      {/* News Impact */}
      {d.explanation.newsImpact && d.explanation.newsImpact !== 'No significant news activity for this symbol.' && (
        <div style={{ fontSize:13, padding:'10px 14px', background:'#F0FDFA', borderLeft:'3px solid #06B6D4', borderRadius:8, marginBottom:12, lineHeight:1.5 }}>
          <strong style={{ fontSize:11, color:'#0E7490', textTransform:'uppercase', letterSpacing:0.5 }}>News Impact</strong>
          <p style={{ margin:'4px 0 0', color:'#2D3748' }}>{d.explanation.newsImpact}</p>
        </div>
      )}

      {/* Caution */}
      {d.explanation.cautionReason && (
        <div style={{ fontSize:13, padding:'10px 14px', background:'#FFFBEB', borderLeft:'3px solid #D97706', borderRadius:8, marginBottom:12, lineHeight:1.5 }}>
          <strong style={{ fontSize:11, color:'#92400E', textTransform:'uppercase', letterSpacing:0.5 }}>Caution</strong>
          <p style={{ margin:'4px 0 0', color:'#92400E' }}>{d.explanation.cautionReason}</p>
        </div>
      )}

      {/* Expand toggle */}
      <button onClick={() => setExpand(!expand)} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#0E7490', fontWeight:700, background:'none', border:'none', cursor:'pointer', marginBottom:12 }}>
        {expand ? 'Show Less' : 'Show Details'} {expand ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expand && (
        <>
          {/* Risk Highlights */}
          {d.explanation.riskHighlights.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <strong style={{ fontSize:11, color:'#DC2626', textTransform:'uppercase', letterSpacing:0.5 }}>Risk Highlights</strong>
              <ul style={{ margin:'6px 0 0', paddingLeft:18 }}>
                {d.explanation.riskHighlights.map((r, i) => <li key={i} style={{ fontSize:13, color:'#2D3748', marginBottom:4, lineHeight:1.5 }}>{r}</li>)}
              </ul>
            </div>
          )}

          {/* Guidance */}
          {d.guidance.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <strong style={{ fontSize:11, color:'#059669', textTransform:'uppercase', letterSpacing:0.5 }}>Guidance</strong>
              <ul style={{ margin:'6px 0 0', paddingLeft:18 }}>
                {d.guidance.map((g, i) => <li key={i} style={{ fontSize:13, color:'#2D3748', marginBottom:4, lineHeight:1.5 }}>{g}</li>)}
              </ul>
            </div>
          )}

          {/* Modifiers */}
          <div style={{ marginBottom:12 }}>
            <strong style={{ fontSize:11, color:'#0E7490', textTransform:'uppercase', letterSpacing:0.5 }}>Modifier Breakdown</strong>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4, marginTop:6 }}>
              {Object.entries(d.modifiers).filter(([k]) => k !== 'totalAdjustment').map(([k, v]) => (
                <div key={k} style={{ display:'flex', justifyContent:'space-between', fontSize:12, padding:'3px 8px', background:'#F0F4F8', borderRadius:4 }}>
                  <span style={{ color:'#5A6A7E' }}>{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <span style={{ fontWeight:700, fontFamily:'monospace', color: v > 0 ? '#059669' : v < 0 ? '#DC2626' : '#5A6A7E' }}>{v > 0 ? `+${v}` : v}</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize:12, fontWeight:700, marginTop:6, textAlign:'right' }}>
              Total: <span style={{ color: d.modifiers.totalAdjustment > 0 ? '#059669' : d.modifiers.totalAdjustment < 0 ? '#DC2626' : '#5A6A7E' }}>
                {d.modifiers.totalAdjustment > 0 ? '+' : ''}{d.modifiers.totalAdjustment}
              </span>
            </div>
          </div>

          {/* Calibration */}
          {d.calibration.feedbackNote && (
            <div style={{ fontSize:12, color:'#5A6A7E', fontStyle:'italic', lineHeight:1.5 }}>{d.calibration.feedbackNote}</div>
          )}
        </>
      )}
    </div>
  );
}
