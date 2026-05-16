'use client';
// ════════════════════════════════════════════════════════════════
//  /signals/engine-health — Phase 5 Engine Health Map page.
//
//  Reads /api/signals/engine-health and renders a structured
//  observability dashboard: overall summary, pipeline readiness,
//  visual process map, per-engine cards, broken dependencies,
//  signal-readiness explanation, data quality, operational links.
//
//  No fabricated health — every NOT_CONFIGURED / INSUFFICIENT_DATA
//  badge comes straight from the API response.
// ════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import {
  ChevronLeft, RefreshCw, Activity, AlertTriangle, CheckCircle2,
  Database, Shield, Target, FlaskConical, FileText, Cpu, Eye,
} from 'lucide-react';

type EngineStatus =
  | 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'BROKEN' | 'STALE'
  | 'NOT_CONFIGURED' | 'INSUFFICIENT_DATA' | 'UNKNOWN';

type OverallStatus = 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';

type EngineCategory =
  | 'DATA' | 'MARKET' | 'SCANNER' | 'INDICATOR' | 'SCORING' | 'RISK'
  | 'CONFIRMATION' | 'DUE_DILIGENCE' | 'REPORTING' | 'BACKTESTING' | 'LEARNING';

interface EngineDiagnostics {
  primaryIssue:        string | null;
  findings:            string[];
  warnings:            string[];
  errors:              string[];
  recommendedActions:  string[];
}
interface EngineLink { label: string; href: string }

interface EngineHealthNode {
  id:                  string;
  name:                string;
  category:            EngineCategory;
  status:              EngineStatus;
  severity:            'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description:         string;
  lastRunAt:           string | null;
  lastSuccessAt:       string | null;
  freshnessMinutes:    number | null;
  inputCount:          number | null;
  outputCount:         number | null;
  errorCount:          number;
  warningCount:        number;
  dependencies:        string[];
  blockedBy:           string[];
  downstreamImpact:    string[];
  diagnostics:         EngineDiagnostics;
  metrics:             Record<string, number | string | boolean | null>;
  links:               EngineLink[];
}

interface EngineHealthEdge {
  from:        string;
  to:          string;
  status:      'OK' | 'WARNING' | 'BROKEN';
  explanation: string;
}

interface PipelineReadiness {
  canGenerateApprovedSignals: boolean;
  canGenerateCandidates:      boolean;
  canRunDueDiligence:         boolean;
  canRunDailyReport:          boolean;
  canRunBacktest:             boolean;
  blockingReasons:            string[];
}

interface EngineHealthMap {
  generatedAt:                  string;
  overallStatus:                OverallStatus;
  overallSummary:               string;
  criticalIssues:               string[];
  warningIssues:                string[];
  healthyCount:                 number;
  warningCount:                 number;
  degradedCount:                number;
  brokenCount:                  number;
  staleCount:                   number;
  notConfiguredCount:           number;
  nodes:                        EngineHealthNode[];
  edges:                        EngineHealthEdge[];
  pipelineReadiness:            PipelineReadiness;
  signalReadinessExplanation:   string;
}

interface ApiEnvelope {
  ok:           boolean;
  generatedAt?: string;
  health?:      EngineHealthMap;
  warnings?:    string[];
}

const STATUS_PALETTE: Record<EngineStatus, { bg: string; color: string; border: string; label: string }> = {
  HEALTHY:           { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'HEALTHY' },
  WARNING:           { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A', label: 'WARNING' },
  DEGRADED:          { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA', label: 'DEGRADED' },
  BROKEN:            { bg: '#FEE2E2', color: '#7F1D1D', border: '#FCA5A5', label: 'BROKEN' },
  STALE:             { bg: '#FEF3C7', color: '#B45309', border: '#FDE68A', label: 'STALE' },
  NOT_CONFIGURED:    { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'NOT CONFIGURED' },
  INSUFFICIENT_DATA: { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'INSUFFICIENT DATA' },
  UNKNOWN:           { bg: '#F8FAFC', color: '#94A3B8', border: '#E2E8F0', label: 'UNKNOWN' },
};

const OVERALL_PALETTE: Record<OverallStatus, { bg: string; color: string; border: string }> = {
  HEALTHY:  { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
  WARNING:  { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
  DEGRADED: { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
  BROKEN:   { bg: '#FEE2E2', color: '#7F1D1D', border: '#FCA5A5' },
  UNKNOWN:  { bg: '#F8FAFC', color: '#94A3B8', border: '#E2E8F0' },
};

// PHASE_B_MANIPULATION — the Manipulation Risk Engine reuses the RISK
// category but renders with a surveillance-themed icon (Eye) so it can
// be visually distinguished from the scoring/risk engine in the
// process map and the engine cards.
function CategoryIcon({ category, nodeId }: { category: EngineCategory; nodeId?: string }) {
  const size = 14;
  if (nodeId === 'manipulation') return <Eye size={size} />;
  switch (category) {
    case 'DATA':         return <Database size={size} />;
    case 'MARKET':       return <Activity size={size} />;
    case 'SCANNER':      return <Target size={size} />;
    case 'INDICATOR':    return <Cpu size={size} />;
    case 'SCORING':      return <Shield size={size} />;
    case 'RISK':         return <Shield size={size} />;
    case 'CONFIRMATION': return <CheckCircle2 size={size} />;
    case 'DUE_DILIGENCE': return <Shield size={size} />;
    case 'REPORTING':    return <FileText size={size} />;
    case 'BACKTESTING':  return <FlaskConical size={size} />;
    case 'LEARNING':     return <Activity size={size} />;
    default:             return <Activity size={size} />;
  }
}

function StatusBadge({ status }: { status: EngineStatus }) {
  const pal = STATUS_PALETTE[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 999,
      background: pal.bg, color: pal.color,
      border: `1px solid ${pal.border}`,
      fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
    }}>{pal.label}</span>
  );
}

function ReadinessChip({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 8,
      background: ok ? '#F0FDF4' : '#FEF2F2',
      border: `1px solid ${ok ? '#BBF7D0' : '#FECACA'}`,
      color: ok ? '#15803D' : '#991B1B',
      fontSize: 12, fontWeight: 700, letterSpacing: 0.3,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
      {label}
    </div>
  );
}

function EmptySection({ message }: { message: string }) {
  return (
    <div style={{
      padding: '14px 16px', background: '#F8FAFC',
      border: '1px dashed #CBD5E1', borderRadius: 8,
      color: '#475569', fontSize: 12,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <AlertTriangle size={14} color="#94A3B8" />
      <span>{message}</span>
    </div>
  );
}

function SkeletonCard() {
  const blockBase: React.CSSProperties = {
    background: 'linear-gradient(90deg, #E2E8F0 0%, #F1F5F9 50%, #E2E8F0 100%)',
    backgroundSize: '200% 100%',
    borderRadius: 4,
    animation: 'engineHealthPulse 1.5s ease-in-out infinite',
  };
  const block = (extra: React.CSSProperties): React.CSSProperties => ({ ...blockBase, ...extra });
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: '#FFFFFF', border: '1px solid #E2E8F0',
      display: 'flex', flexDirection: 'column', gap: 8,
    }} aria-busy="true" aria-live="polite">
      {/* Title row: icon + title + status badge + category chip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={block({ width: 14, height: 14, borderRadius: 4 })} />
        <div style={block({ width: 130, height: 13 })} />
        <div style={block({ width: 64, height: 16, borderRadius: 999 })} />
        <div style={block({ width: 52, height: 14, borderRadius: 4 })} />
      </div>
      {/* Description placeholders */}
      <div style={block({ width: '100%', height: 10, marginTop: 2 })} />
      <div style={block({ width: '88%', height: 10 })} />
      <div style={block({ width: '62%', height: 10 })} />
      {/* Metrics row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
        <div style={block({ width: 90, height: 10 })} />
        <div style={block({ width: 78, height: 10 })} />
        <div style={block({ width: 68, height: 10 })} />
        <div style={block({ width: 72, height: 10 })} />
      </div>
      {/* Footer chips */}
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <div style={block({ width: 56, height: 18, borderRadius: 4 })} />
        <div style={block({ width: 64, height: 18, borderRadius: 4 })} />
      </div>
    </div>
  );
}

function NodeCard({ node }: { node: EngineHealthNode }) {
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: '#FFFFFF', border: '1px solid #E2E8F0',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <CategoryIcon category={node.category} nodeId={node.id} />
        <strong style={{ fontSize: 13, color: '#0F172A' }}>{node.name}</strong>
        <StatusBadge status={node.status} />
        <span style={{
          fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
          padding: '1px 6px', borderRadius: 4,
          background: '#F8FAFC', color: '#475569', border: '1px solid #CBD5E1',
        }} title="Engine category">{node.category}</span>
        {node.id === 'manipulation' && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.4,
            padding: '1px 6px', borderRadius: 4,
            background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A',
          }} title="Surveillance/Risk layer for abnormal activity and manipulation-risk gating.">
            SURVEILLANCE
          </span>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: '#475569', lineHeight: 1.5 }}>
        {node.description}
      </div>
      {node.diagnostics.primaryIssue && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#B45309' }}>
          <strong>Primary issue:</strong> {node.diagnostics.primaryIssue}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 4, fontSize: 11, color: '#475569' }}>
        {node.lastSuccessAt && (
          <span>Last success: <strong>{new Date(node.lastSuccessAt).toLocaleTimeString()}</strong></span>
        )}
        {node.freshnessMinutes != null && (
          <span>Freshness: <strong>{node.freshnessMinutes}m</strong></span>
        )}
        {node.inputCount != null && (
          <span>Input: <strong>{node.inputCount}</strong></span>
        )}
        {node.outputCount != null && (
          <span>Output: <strong>{node.outputCount}</strong></span>
        )}
      </div>
      {node.diagnostics.warnings.length > 0 && (
        <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>
          {node.diagnostics.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {node.diagnostics.errors.length > 0 && (
        <ul style={{ margin: '4px 0 0 0', paddingLeft: 18, fontSize: 11, color: '#991B1B', lineHeight: 1.5 }}>
          {node.diagnostics.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
      {node.diagnostics.recommendedActions.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#1D4ED8' }}>
          <strong>Recommended:</strong> {node.diagnostics.recommendedActions[0]}
        </div>
      )}
      {node.blockedBy.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11, color: '#7F1D1D' }}>
          <strong>Blocked by:</strong> {node.blockedBy.join(', ')}
        </div>
      )}
      {node.links.length > 0 && (
        <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {node.links.map((l, i) => (
            <Link key={i} href={l.href} style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
              color: '#1D4ED8', textDecoration: 'none',
              padding: '2px 6px', borderRadius: 4,
              background: '#EFF6FF', border: '1px solid #BFDBFE',
            }}>
              {l.label} →
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function ProcessMap({ nodes }: { nodes: EngineHealthNode[] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', gap: 6,
      flexWrap: 'wrap', padding: '6px 0',
    }}>
      {nodes.map((n, i) => (
        <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            padding: '8px 10px', borderRadius: 8,
            background: STATUS_PALETTE[n.status].bg,
            border: `1px solid ${STATUS_PALETTE[n.status].border}`,
            color: STATUS_PALETTE[n.status].color,
            minWidth: 130,
            fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
          }} title={n.diagnostics.primaryIssue ?? n.description}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <CategoryIcon category={n.category} nodeId={n.id} />
              <span>{n.name}</span>
            </div>
            <div style={{ marginTop: 2, fontSize: 9, fontWeight: 700, letterSpacing: 0.5 }}>
              {STATUS_PALETTE[n.status].label}
            </div>
            <div style={{ marginTop: 2, fontSize: 9, color: '#64748B', fontWeight: 600 }}>
              {n.outputCount != null ? `out ${n.outputCount}` : ''}
              {n.inputCount != null && n.outputCount != null ? ' · ' : ''}
              {n.inputCount != null ? `in ${n.inputCount}` : ''}
            </div>
          </div>
          {i < nodes.length - 1 && (
            <span style={{ color: '#94A3B8', fontSize: 14 }}>→</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function EngineHealthPage() {
  const [data, setData]       = useState<ApiEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);

  const load = async () => {
    loadAbortRef.current?.abort('superseded');
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signals/engine-health', {
        cache: 'no-store', signal: controller.signal,
      });
      if (!res.ok) {
        setError(`API returned ${res.status}`);
        setData(null);
        return;
      }
      if (!controller.signal.aborted) setData(await res.json() as ApiEnvelope);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return; // expected on supersede/unmount
      setError(err.message ?? 'Failed to load engine health');
      setData(null);
    } finally {
      if (loadAbortRef.current === controller) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => { loadAbortRef.current?.abort('unmount'); };
  }, []);

  const health = data?.health ?? null;
  const overall = health?.overallStatus ?? 'UNKNOWN';
  const overallPal = OVERALL_PALETTE[overall];

  return (
    <AppShell title="Signal Engine Health Map">
      <div className="page">
        {/* Skeleton pulse keyframes — deterministic, no hydration mismatch */}
        <style>{`
@keyframes engineHealthPulse {
  0%   { background-position: 200% 0; opacity: 1; }
  50%  { background-position: 0 0;    opacity: 0.65; }
  100% { background-position: -200% 0; opacity: 1; }
}
`}</style>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <Link href="/signals" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 12, color: '#475569', textDecoration: 'none',
            padding: '6px 10px', borderRadius: 6,
            background: '#F8FAFC', border: '1px solid #E2E8F0',
          }}>
            <ChevronLeft size={14} /> Back to Signal Engine
          </Link>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>
            Signal Engine Health Map
          </h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={() => void load()}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Overall summary */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{
              padding: '4px 12px', borderRadius: 999,
              background: overallPal.bg, color: overallPal.color,
              border: `1px solid ${overallPal.border}`,
              fontSize: 12, fontWeight: 800, letterSpacing: 0.5,
            }}>OVERALL: {overall}</span>
            {health?.generatedAt && (
              <span style={{ fontSize: 11, color: '#94A3B8' }}>
                Generated {new Date(health.generatedAt).toLocaleTimeString()}
              </span>
            )}
            {health && (
              <span style={{ fontSize: 11, color: '#475569' }}>
                Healthy: <strong style={{ color: '#15803D' }}>{health.healthyCount}</strong> ·
                Warning: <strong style={{ color: '#92400E' }}> {health.warningCount}</strong> ·
                Degraded: <strong style={{ color: '#B91C1C' }}> {health.degradedCount}</strong> ·
                Broken: <strong style={{ color: '#7F1D1D' }}> {health.brokenCount}</strong> ·
                Stale: <strong style={{ color: '#B45309' }}> {health.staleCount}</strong> ·
                Not configured: <strong style={{ color: '#475569' }}> {health.notConfiguredCount}</strong>
              </span>
            )}
          </div>
          {health && (
            <div style={{ marginTop: 8, fontSize: 13, color: '#0F172A', fontWeight: 600 }}>
              {health.overallSummary}
            </div>
          )}
          {health?.signalReadinessExplanation && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#334155' }}>
              {health.signalReadinessExplanation}
            </div>
          )}
          {error && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#B91C1C' }}>{error}</div>
          )}
          {data?.warnings && data.warnings.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18, fontSize: 11.5, color: '#92400E', lineHeight: 1.5 }}>
              {data.warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </Card>

        {/* Pipeline readiness */}
        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
            Pipeline Readiness
          </h2>
          {health ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                <ReadinessChip label="Can generate candidates"        ok={health.pipelineReadiness.canGenerateCandidates} />
                <ReadinessChip label="Can generate approved signals"  ok={health.pipelineReadiness.canGenerateApprovedSignals} />
                <ReadinessChip label="Can run due diligence"          ok={health.pipelineReadiness.canRunDueDiligence} />
                <ReadinessChip label="Can run daily report"           ok={health.pipelineReadiness.canRunDailyReport} />
                <ReadinessChip label="Can run backtest"               ok={health.pipelineReadiness.canRunBacktest} />
              </div>
              {health.pipelineReadiness.blockingReasons.length > 0 && (
                <ul style={{ marginTop: 12, paddingLeft: 18, fontSize: 12, color: '#7F1D1D', lineHeight: 1.5 }}>
                  {health.pipelineReadiness.blockingReasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              )}
            </>
          ) : (
            <EmptySection message={loading ? 'Loading…' : 'No readiness data.'} />
          )}
        </Card>

        {/* Process map */}
        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
            Process Map
          </h2>
          {health && health.nodes.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <ProcessMap nodes={health.nodes} />
            </div>
          ) : (
            <EmptySection message="No engines mapped." />
          )}
        </Card>

        {/* Critical / warning issues */}
        {health && (health.criticalIssues.length > 0 || health.warningIssues.length > 0) && (
          <Card style={{ marginBottom: 16 }}>
            <h2 style={{ margin: '0 0 10px 0', fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
              Open Issues
            </h2>
            {health.criticalIssues.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#B91C1C', marginBottom: 4 }}>
                  CRITICAL
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#7F1D1D', lineHeight: 1.55 }}>
                  {health.criticalIssues.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            {health.warningIssues.length > 0 && (
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#B45309', marginBottom: 4 }}>
                  WARNINGS
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#92400E', lineHeight: 1.55 }}>
                  {health.warningIssues.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
          </Card>
        )}

        {/* Engine cards */}
        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
            Engine Details
          </h2>
          {loading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
            </div>
          ) : health && health.nodes.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {health.nodes.map((n) => <NodeCard key={n.id} node={n} />)}
            </div>
          ) : (
            <EmptySection message="No engine cards available." />
          )}
        </Card>

        {/* Operational links */}
        <Card style={{ marginBottom: 16 }}>
          <h2 style={{ margin: '0 0 10px 0', fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
            Operational Actions
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Link href="/signals" style={opLinkStyle}>Open Signal Engine</Link>
            <Link href="/signals/daily-report" style={opLinkStyle}>Open Daily Report</Link>
            <Link href="/signals/backtesting" style={opLinkStyle}>Open Backtesting Lab</Link>
          </div>
        </Card>

        <div style={{ marginTop: 16, fontSize: 10, color: '#94A3B8', textAlign: 'center' }}>
          Engine health is observational only and is not financial advice.
        </div>
      </div>
    </AppShell>
  );
}

const opLinkStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px', borderRadius: 6,
  background: '#FFFFFF', color: '#1D4ED8',
  border: '1px solid #BFDBFE',
  fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textDecoration: 'none',
};
