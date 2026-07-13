'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Loading, Badge } from '@/components/ui';
import { useStrategyValidation } from '@/hooks/useStrategyValidation';
import type { ValidationCategory, ValidationReport } from '@/lib/strategy-hub/validation/types';
import styles from '@/app/strategies/strategies.module.scss';

const CATEGORY_LABELS: Record<ValidationCategory, string> = {
  configuration: 'Configuration',
  integrity: 'Strategy Integrity',
  signal_engine: 'Signal Engine',
  risk: 'Risk',
  performance: 'Performance',
  deployment: 'Deployment',
};

function statusBadgeVariant(status: string): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'ready' || status === 'pass') return 'green';
  if (status === 'warning') return 'orange';
  if (status === 'failed' || status === 'failure') return 'red';
  return 'gray';
}

function fmtWhen(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

interface Props {
  strategyId: string;
  canManage: boolean;
}

export function StrategyValidationPanel({ strategyId, canManage }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useStrategyValidation(strategyId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<[number | null, number | null]>([null, null]);
  const [report, setReport] = useState<ValidationReport | null>(null);

  const displayReport = report ?? data?.latest?.report ?? null;
  const validationId = report?.validationId ?? data?.latest?.validationId;

  const runValidation = async (persist = true) => {
    setBusy(true);
    setMessage(null);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/strategies/${strategyId}/validation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ target: 'assessment', persist }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Validation failed');
      setReport(body.report as ValidationReport);
      setMessage(body.message ?? 'Validation complete');
      await queryClient.invalidateQueries({ queryKey: ['strategy-validation', strategyId] });
      await queryClient.invalidateQueries({ queryKey: ['strategy-detail', strategyId] });
      await queryClient.invalidateQueries({ queryKey: ['strategy-hub'] });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setBusy(false);
    }
  };

  const exportReport = async () => {
    if (!validationId) return;
    window.open(`/api/strategies/${strategyId}/validation/export?validationId=${validationId}`, '_blank');
  };

  const loadHistorical = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/strategies/${strategyId}/validation?validationId=${id}`, {
        credentials: 'include',
      });
      const body = await res.json();
      if (body.ok) setReport(body.report);
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return <Card title="Strategy Validation"><Loading text="Loading validation status…" /></Card>;
  }

  if (error) {
    return (
      <Card title="Strategy Validation">
        <p style={{ color: '#DC2626' }}>Could not load validation status.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Strategy Validation"
      action={
        canManage && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => refetch()}>
              Refresh
            </button>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => runValidation(true)}>
              {busy ? 'Validating…' : displayReport ? 'Revalidate' : 'Validate Strategy'}
            </button>
          </div>
        )
      }
    >
      {!displayReport && (
        <p style={{ color: '#64748B', fontSize: '0.9rem' }}>
          No validation recorded yet.
          {canManage ? ' Run validation before deploying to paper or live.' : ' Ask an administrator to validate this strategy.'}
        </p>
      )}

      {displayReport && (
        <>
          <div className={styles.validationHero}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: 4 }}>Overall Status</div>
              <Badge variant={statusBadgeVariant(displayReport.overallStatus)}>
                {displayReport.overallStatus.toUpperCase()}
              </Badge>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: 4 }}>Score</div>
              <div style={{ fontSize: '2rem', fontWeight: 700 }}>{displayReport.overallScore}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: 4 }}>Pass Rate</div>
              <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>{displayReport.passPercentage}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#64748B', marginBottom: 4 }}>Deploy Ready</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Badge variant={displayReport.paperDeployReady ? 'green' : 'red'}>Paper</Badge>
                <Badge variant={displayReport.liveDeployReady ? 'green' : 'orange'}>Live</Badge>
              </div>
            </div>
          </div>

          <div style={{ fontSize: '0.8rem', color: '#64748B', marginBottom: 16 }}>
            Validated {fmtWhen(displayReport.summary.validatedAt)} · {displayReport.summary.executionTimeMs}ms ·
            Config v{displayReport.configVersion} · {displayReport.summary.passed}/{displayReport.summary.total} passed
          </div>

          <div className={styles.validationCategories}>
            {displayReport.categoryScores.map((cat) => (
              <div key={cat.category} className={styles.validationCategoryCard}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{CATEGORY_LABELS[cat.category]}</div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{cat.score}</div>
                <div style={{ fontSize: '0.75rem', color: '#64748B' }}>
                  {cat.passed} pass · {cat.warnings} warn · {cat.failed} fail
                </div>
              </div>
            ))}
          </div>

          {displayReport.blockedReasons.length > 0 && (
            <div className={styles.cardMessage} style={{ marginBottom: 12, color: '#DC2626' }}>
              <strong>Deployment blocked:</strong> {displayReport.blockedReasons.join(' · ')}
            </div>
          )}

          <h4 style={{ fontSize: '0.95rem', marginBottom: 8 }}>Findings</h4>
          <ul className={styles.validationFindings}>
            {displayReport.checks.map((c) => (
              <li key={c.id} className={styles.validationFinding}>
                <Badge variant={statusBadgeVariant(c.status)} style={{ fontSize: '0.65rem' }}>
                  {c.status}
                </Badge>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{c.name}</div>
                  <div style={{ fontSize: '0.8rem', color: '#64748B' }}>{c.message}</div>
                  {c.recommendation && (
                    <div style={{ fontSize: '0.78rem', color: '#1E40AF', marginTop: 2 }}>
                      → {c.recommendation}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: '0.7rem', color: '#94A3B8' }}>{CATEGORY_LABELS[c.category]}</span>
              </li>
            ))}
          </ul>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            {validationId && (
              <button type="button" className="btn btn--outline btn--sm" onClick={exportReport}>
                Export Report (JSON)
              </button>
            )}
            {data?.latest && report && (
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setReport(null)}>
                View Latest
              </button>
            )}
          </div>
        </>
      )}

      {data?.history && data.history.length > 0 && (
        <>
          <h4 style={{ fontSize: '0.95rem', margin: '20px 0 8px' }}>Validation History</h4>
          <div className={styles.deploymentTableWrap}>
            <table className={styles.deploymentTable}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>When</th>
                  <th>By</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id}>
                    <td>#{h.id}</td>
                    <td><Badge variant={statusBadgeVariant(h.overallStatus)}>{h.overallStatus}</Badge></td>
                    <td>{h.validationScore}</td>
                    <td style={{ fontSize: '0.8rem' }}>{fmtWhen(h.createdAt)}</td>
                    <td style={{ fontSize: '0.8rem' }}>{h.actor ?? '—'}</td>
                    <td>
                      <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => loadHistorical(h.id)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.history.length >= 2 && (
            <div style={{ marginTop: 12, fontSize: '0.85rem' }}>
              <strong>Compare runs:</strong>{' '}
              <select
                className="input"
                style={{ width: 80, padding: '2px 6px', marginRight: 8 }}
                value={compareIds[0] ?? ''}
                onChange={(e) => setCompareIds([Number(e.target.value) || null, compareIds[1]])}
              >
                <option value="">A</option>
                {data.history.map((h) => <option key={h.id} value={h.id}>#{h.id}</option>)}
              </select>
              vs
              <select
                className="input"
                style={{ width: 80, padding: '2px 6px', marginLeft: 8 }}
                value={compareIds[1] ?? ''}
                onChange={(e) => setCompareIds([compareIds[0], Number(e.target.value) || null])}
              >
                <option value="">B</option>
                {data.history.map((h) => <option key={h.id} value={h.id}>#{h.id}</option>)}
              </select>
              {compareIds[0] && compareIds[1] && (
                <span style={{ marginLeft: 12, color: '#64748B' }}>
                  {(() => {
                    const a = data.history.find((h) => h.id === compareIds[0]);
                    const b = data.history.find((h) => h.id === compareIds[1]);
                    if (!a || !b) return null;
                    const delta = b.validationScore - a.validationScore;
                    return `Score Δ ${delta >= 0 ? '+' : ''}${delta} (${a.overallStatus} → ${b.overallStatus})`;
                  })()}
                </span>
              )}
            </div>
          )}
        </>
      )}

      {message && <div className={styles.cardMessage} style={{ marginTop: 12 }}>{message}</div>}
      {errorMsg && <div className={styles.cardMessage} style={{ marginTop: 12, color: '#DC2626' }}>{errorMsg}</div>}
    </Card>
  );
}
