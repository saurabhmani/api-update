'use client';

import { useState } from 'react';
import { Card } from '@/components/ui';

interface RunRow {
  run_id: string;
  name: string;
  status: string;
}

interface Props {
  runs: RunRow[];
}

interface ComparisonResult {
  runs: Array<{ runId: string; name: string; summary: Record<string, number> | null }>;
  deltas: Array<{ metric: string; values: Record<string, number | null>; bestRunId: string | null }>;
  winner: { byReturn: string | null; bySharpe: string | null; byDrawdown: string | null };
}

async function readCompareJson(res: Response) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`Compare API returned an empty response (status ${res.status})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Compare API returned invalid JSON (status ${res.status})`);
  }
}

function isCompleted(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === 'completed' || normalized === 'success' || normalized === 'partial_success';
}

export function BacktestComparePanel({ runs }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [data, setData] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const completed = runs.filter((r) => isCompleted(r.status));

  const toggle = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < 4 ? [...prev, id] : prev,
    );
  };

  const compare = async () => {
    if (selected.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/backtests/compare?ids=${selected.join(',')}`, { cache: 'no-store' });
      const body = await readCompareJson(res);
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Compare failed');
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compare failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <Card title="Compare Backtests" compact>
        <p style={{ fontSize: '0.85rem', color: '#64748B', margin: '0 0 12px' }}>
          Select 2–4 completed runs to compare Sharpe, Sortino, drawdown, and return side-by-side.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {completed.map((r) => (
            <button
              key={r.run_id}
              type="button"
              className={selected.includes(r.run_id) ? 'btn btn--primary btn--sm' : 'btn btn--outline btn--sm'}
              onClick={() => toggle(r.run_id)}
            >
              {r.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={compare}
          disabled={selected.length < 2 || loading}
        >
          {loading ? 'Comparing…' : `Compare ${selected.length} Runs`}
        </button>
        {error && <p style={{ color: '#DC2626', fontSize: '0.85rem', marginTop: 8 }}>{error}</p>}
      </Card>

      {data && (
        <Card title="Comparison Results" flush style={{ marginTop: 16 }}>
          <div style={{ padding: 12, fontSize: '0.8rem', color: '#64748B' }}>
            Best return: <strong>{data.winner.byReturn ?? '—'}</strong>
            {' · '}Best Sharpe: <strong>{data.winner.bySharpe ?? '—'}</strong>
            {' · '}Lowest drawdown: <strong>{data.winner.byDrawdown ?? '—'}</strong>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table table--compact">
              <thead>
                <tr>
                  <th>Metric</th>
                  {data.runs.map((r) => <th key={r.runId}>{r.name}</th>)}
                  <th>Best</th>
                </tr>
              </thead>
              <tbody>
                {data.deltas.map((d) => (
                  <tr key={d.metric}>
                    <td><strong>{d.metric}</strong></td>
                    {data.runs.map((r) => {
                      const v = d.values[r.runId];
                      const formatted = typeof v === 'number'
                        ? d.metric.includes('%') || d.metric.includes('Rate')
                          ? `${(v * (v <= 1 && v >= 0 && d.metric.includes('Rate') ? 100 : 1)).toFixed(2)}${d.metric.includes('Rate') ? '%' : ''}`
                          : v.toFixed(2)
                        : '—';
                      return (
                        <td key={r.runId} style={{
                          fontWeight: d.bestRunId === r.runId ? 700 : 400,
                          color: d.bestRunId === r.runId ? '#15803D' : undefined,
                        }}>
                          {formatted}
                        </td>
                      );
                    })}
                    <td style={{ color: '#64748B', fontSize: '0.75rem' }}>{d.bestRunId?.slice(0, 8) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
