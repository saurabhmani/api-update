'use client';

import { useState } from 'react';
import { Card, Badge, Loading } from '@/components/ui';
import { useTrustSignals, useSignalReasons, useSignalWarnings } from '@/hooks/trust/useTrustSignals';
import type { SignalBoardFilters } from '@/hooks/trust/useTrustSignals';
import { fmt } from '@/lib/utils';

export function SignalBoardTable() {
  // Default to `all` so users see something on the first page load even when
  // the confirmed-signals table has no live rows yet. The old default was
  // `active`, which returned an empty list off-hours and made the tab look
  // broken.
  const [filters, setFilters] = useState<SignalBoardFilters>({ status: 'all', limit: 50 });
  const { data: signals, isLoading } = useTrustSignals(filters);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data: reasons } = useSignalReasons(selectedId);
  const { data: warnings } = useSignalWarnings(selectedId);

  if (isLoading) return <Loading text="Loading signal board…" />;

  const rows = signals ?? [];
  const strategies = [...new Set(rows.map((r) => r.strategy).filter(Boolean))] as string[];
  const activeCount = rows.filter((r) => r.lifecycle === 'active').length;
  const closedCount = rows.length - activeCount;
  const showingAllHint =
    filters.status === 'all' && activeCount === 0 && closedCount > 0;

  return (
    <div>
      <Card
        title={`Signal Board (${rows.length})`}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="input"
              style={{ width: 100, padding: '4px 8px' }}
              value={filters.status ?? 'active'}
              onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SignalBoardFilters['status'] }))}
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </select>
            <select
              className="input"
              style={{ width: 90, padding: '4px 8px' }}
              value={filters.direction ?? ''}
              onChange={(e) => setFilters((f) => ({
                ...f,
                direction: e.target.value ? e.target.value as 'BUY' | 'SELL' : undefined,
              }))}
            >
              <option value="">All dirs</option>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
            <select
              className="input"
              style={{ width: 140, padding: '4px 8px' }}
              value={filters.strategy ?? ''}
              onChange={(e) => setFilters((f) => ({
                ...f,
                strategy: e.target.value || undefined,
              }))}
            >
              <option value="">All strategies</option>
              {strategies.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        }
        flush
      >
        {showingAllHint && (
          <div style={{
            padding: '8px 16px', fontSize: 12, color: '#64748B',
            background: '#F8FAFC', borderBottom: '1px solid #E2E8F0',
          }}>
            No active signals right now — showing {closedCount} recent closed rows.
            Switch the filter above to <strong>Active</strong> once new signals confirm.
          </div>
        )}
        <div style={{ overflowX: 'auto' }}>
          <table className="table table--compact">
            <thead>
              <tr>
                <th>Status</th>
                <th>Symbol</th>
                <th>Dir</th>
                <th>Strategy</th>
                <th>Entry</th>
                <th>Stop</th>
                <th>T1</th>
                <th>T2</th>
                <th>R:R</th>
                <th>Edge %</th>
                <th>Conf</th>
                <th>Regime adj</th>
                <th>Reason</th>
                <th>Sources</th>
                <th>Warning</th>
                <th>Inst. warning</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={16} style={{ textAlign: 'center', padding: 24, color: '#94A3B8' }}>No signals match filters</td></tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedId(row.id)}
                  style={{ cursor: 'pointer', background: selectedId === row.id ? '#F1F5F9' : undefined }}
                >
                  <td>
                    <Badge variant={row.lifecycle === 'active' ? 'green' : 'gray'}>
                      {row.lifecycle}
                    </Badge>
                  </td>
                  <td><strong>{row.symbol}</strong></td>
                  <td>
                    <Badge variant={row.direction === 'BUY' ? 'green' : 'red'}>{row.direction}</Badge>
                  </td>
                  <td>{row.strategyDisplay ?? row.strategy ?? '—'}</td>
                  <td>{fmt.currency(row.tradePlan.entry)}</td>
                  <td>{fmt.currency(row.tradePlan.stopLoss)}</td>
                  <td>{fmt.currency(row.tradePlan.target1)}</td>
                  <td>{row.tradePlan.target2 != null ? fmt.currency(row.tradePlan.target2) : '—'}</td>
                  <td>{row.tradePlan.riskReward.toFixed(2)}</td>
                  <td>{row.tradePlan.expectedEdgePercent.toFixed(1)}%</td>
                  <td title={`Base ${row.baseConfidence} → ${row.confidence}`}>
                    {row.confidence}
                  </td>
                  <td style={{ fontSize: '0.75rem', color: row.regimeModifier >= 0 ? '#16A34A' : '#DC2626' }}>
                    {row.regimeModifier >= 0 ? '+' : ''}{row.regimeModifier}
                  </td>
                  <td style={{ maxWidth: 140, fontSize: '0.8rem' }}>{row.reasons[0] ?? '—'}</td>
                  <td style={{ maxWidth: 120 }}>
                    {(row.reasonSources ?? []).length === 0 ? (
                      <span style={{ fontSize: '0.75rem', color: '#94A3B8' }}>—</span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(row.reasonSources ?? []).map((s) => (
                          <Badge key={s} variant="gray">{s}</Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td style={{ maxWidth: 120, fontSize: '0.8rem', color: '#B45309' }}>{row.warnings[0] ?? '—'}</td>
                  <td
                    style={{ maxWidth: 140, fontSize: '0.8rem', color: '#DC2626' }}
                    title={row.institutionalWarnings.join(' • ')}
                  >
                    {row.institutionalWarnings[0] ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {selectedId && (reasons || warnings) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
          <Card title="Signal Reasons" compact>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem' }}>
              {(reasons?.reasons ?? []).map((r: string) => <li key={r}>{r}</li>)}
            </ul>
          </Card>
          <Card title="Signal Warnings" compact>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', color: '#B45309' }}>
              {(warnings?.warnings ?? []).map((w: string) => <li key={w}>{w}</li>)}
            </ul>
            {rows.find((r) => r.id === selectedId)?.regimeAdjustmentReason && (
              <p style={{ marginTop: 12, fontSize: '0.8rem', color: '#64748B' }}>
                Regime: {rows.find((r) => r.id === selectedId)?.regimeAdjustmentReason}
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
