'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Brain, Target, PieChart, RefreshCw, FileText, Key, Briefcase,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Loading, AlertBanner } from '@/components/ui';
import { DISCLAIMERS } from '@/lib/constants/disclaimer';
import styles from './quant.module.scss';

type Tab = 'research' | 'recommendations' | 'portfolio' | 'reports' | 'api';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'research', label: 'AI Research Assistant', icon: Brain },
  { id: 'recommendations', label: 'Strategy Recommendations', icon: Target },
  { id: 'portfolio', label: 'Portfolio Optimizer', icon: PieChart },
  { id: 'reports', label: 'Enterprise Reports', icon: FileText },
  { id: 'api', label: 'API Management', icon: Key },
];

export default function QuantPage() {
  const [tab, setTab] = useState<Tab>('research');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [symbol, setSymbol] = useState('RELIANCE');
  const [data, setData] = useState<any>(null);
  const [newKeyName, setNewKeyName] = useState('My Integration');
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  const load = useCallback(async (t: Tab) => {
    setLoading(true);
    setError('');
    setData(null);
    try {
      let url = '';
      switch (t) {
        case 'research':
          url = '/api/research?action=market';
          break;
        case 'recommendations':
          url = '/api/recommendations';
          break;
        case 'portfolio':
          url = '/api/portfolio/optimize';
          break;
        case 'reports':
          url = '/api/quant/reports?type=full';
          break;
        case 'api':
          url = '/api/quant/api-keys';
          break;
      }
      const res = await fetch(url);
      const json = await res.json();
      if (json.success === false) throw new Error(json.error ?? 'Request failed');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(tab); }, [tab, load]);

  const generateReport = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'full', symbol: symbol || undefined }),
      });
      const json = await res.json();
      if (json.success === false) throw new Error(json.error);
      setData({ sections: json.report?.sections, report: json.report });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to generate');
    } finally {
      setLoading(false);
    }
  };

  const optimizePortfolio = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/portfolio/optimize', { method: 'POST' });
      const json = await res.json();
      if (json.success === false) throw new Error(json.error);
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Optimization failed');
    } finally {
      setLoading(false);
    }
  };

  const createKey = async () => {
    setLoading(true);
    setError('');
    setCreatedKey(null);
    try {
      const res = await fetch('/api/quant/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName, scopes: ['read'] }),
      });
      const json = await res.json();
      if (json.success === false) throw new Error(json.error);
      setCreatedKey(json.rawKey);
      await load('api');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create key');
    } finally {
      setLoading(false);
    }
  };

  const actionClass = (a: string) => {
    const m: Record<string, string> = {
      PROMOTE: styles.promote, ACTIVE: styles.active,
      REDUCE: styles.reduce, BLOCK: styles.block,
    };
    return m[a] ?? '';
  };

  return (
    <AppShell title="Quant Intelligence Platform">
      <p style={{ color: '#64748B', fontSize: '0.875rem', marginBottom: 16 }}>
        Explainable AI research, regime-aware strategy recommendations, portfolio optimization,
        enterprise reports, and API management.
      </p>

      <div className={styles.tabs}>
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={tab === id ? styles.tabActive : styles.tab}
            onClick={() => setTab(id)}
          >
            <Icon size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'research' && (
        <div className={styles.toolbar}>
          <Input
            label="Symbol (optional)"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            style={{ maxWidth: 160 }}
          />
          <Button onClick={generateReport} loading={loading}>Generate Report</Button>
          <Button variant="ghost" onClick={() => load('research')}><RefreshCw size={14} /></Button>
        </div>
      )}

      {tab === 'portfolio' && (
        <div className={styles.toolbar}>
          <Button onClick={optimizePortfolio} loading={loading}>Run Optimization</Button>
        </div>
      )}

      {error && <AlertBanner variant="error">{error}</AlertBanner>}
      {loading && <Loading />}

      {!loading && tab === 'research' && data?.sections && (
        <Card>
          {data.report?.riskWarnings?.length > 0 && (
            <AlertBanner variant="warning" style={{ marginBottom: 16 }}>
              <strong>Risk Warnings:</strong>{' '}
              {data.report.riskWarnings.join(' · ')}
            </AlertBanner>
          )}
          {data.sections.map((s: any, i: number) => (
            <div key={i} className={styles.section}>
              <h3>
                {s.title}
                {s.confidence != null && (
                  <Badge variant="gray" style={{ marginLeft: 8 }}>
                    {Math.round(s.confidence * 100)}%
                  </Badge>
                )}
              </h3>
              <p>{s.content}</p>
              {s.dataSources?.length > 0 && (
                <p style={{ fontSize: '0.75rem', color: '#94A3B8', marginTop: 4 }}>
                  Sources: {s.dataSources.join(', ')}
                </p>
              )}
              {s.riskWarnings?.length > 0 && (
                <p style={{ fontSize: '0.75rem', color: '#B45309', marginTop: 4 }}>
                  ⚠ {s.riskWarnings.join(' · ')}
                </p>
              )}
            </div>
          ))}
          <p style={{ fontSize: '0.75rem', color: '#94A3B8', marginTop: 16 }}>{DISCLAIMERS.STANDARD}</p>
        </Card>
      )}

      {!loading && tab === 'recommendations' && data?.recommendations && (
        <Card>
          <p style={{ marginBottom: 12 }}>
            Regime: <strong>{data.regime}</strong> ({data.regimeStatus}) —
            Confidence: <strong>{data.overallConfidence}%</strong>
          </p>
          <table className={styles.table}>
            <thead>
              <tr><th>Rank</th><th>Strategy</th><th>Action</th><th>Confidence</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {(data.ranking ?? data.recommendations).map((r: any) => (
                <tr key={r.strategyId}>
                  <td>#{r.rank}</td>
                  <td>{r.strategyName}</td>
                  <td><span className={`${styles.badge} ${actionClass(r.action)}`}>{r.action}</span></td>
                  <td>{r.confidence}%</td>
                  <td>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {!loading && tab === 'portfolio' && (
        <Card>
          {!data?.hasPortfolio ? (
            <Empty
              icon={Briefcase}
              title="No portfolio found"
              description="Create a portfolio to run optimization."
            />
          ) : (
            <>
              <div className={styles.grid2} style={{ marginBottom: 16 }}>
                <div className={styles.stat}>
                  <small>Risk Score</small>
                  <strong>{data.data.metrics.riskScore}/100</strong>
                </div>
                <div className={styles.stat}>
                  <small>Diversification</small>
                  <strong>{data.data.metrics.diversificationScore}/100</strong>
                </div>
                <div className={styles.stat}>
                  <small>Effective Positions</small>
                  <strong>{data.data.metrics.effectivePositions}</strong>
                </div>
                <div className={styles.stat}>
                  <small>Avg Correlation</small>
                  <strong>{data.data.metrics.avgCorrelation}</strong>
                </div>
              </div>
              <table className={styles.table}>
                <thead>
                  <tr><th>Symbol</th><th>Current %</th><th>Target %</th><th>Delta</th></tr>
                </thead>
                <tbody>
                  {(data.data.allocations ?? []).map((a: any) => (
                    <tr key={a.symbol}>
                      <td>{a.symbol}</td>
                      <td>{a.currentWeight}%</td>
                      <td>{a.targetWeight}%</td>
                      <td style={{ color: a.delta > 0 ? '#166534' : a.delta < 0 ? '#991B1B' : undefined }}>
                        {a.delta > 0 ? '+' : ''}{a.delta}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul style={{ fontSize: '0.8rem', color: '#64748B', marginTop: 12 }}>
                {(data.data.explainability ?? []).map((e: string, i: number) => <li key={i}>{e}</li>)}
              </ul>
            </>
          )}
        </Card>
      )}

      {!loading && tab === 'reports' && data?.report && (
        <Card>
          <h3>{data.report.title}</h3>
          {(data.report.sections ?? []).map((s: any, i: number) => (
            <div key={i} className={styles.section}>
              <h3>{s.title}</h3>
              <p>{s.content}</p>
            </div>
          ))}
        </Card>
      )}

      {!loading && tab === 'api' && (
        <Card>
          <div className={styles.toolbar}>
            <Input label="Client name" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
            <Button onClick={createKey} loading={loading}>Create API Key</Button>
            <Button variant="ghost" onClick={() => load('api')}><RefreshCw size={14} /></Button>
          </div>
          {createdKey && (
            <div className={styles.keyReveal}>
              <strong>New API key (copy now):</strong><br />{createdKey}
            </div>
          )}
          <p style={{ fontSize: '0.85rem', marginTop: 16 }}>
            Public endpoints: <code>/api/public/v1/signals</code>,{' '}
            <code>/api/public/v1/recommendations</code>,{' '}
            <code>/api/public/v1/market-regime</code>
          </p>
          <p style={{ fontSize: '0.8rem', color: '#64748B' }}>
            <code>/api/public/v1/signals</code> — no auth required (30 req/min IP).
            Optional <code>Authorization: Bearer q365_...</code> for higher limits.
            See <code>docs/PUBLIC_SIGNALS_API.md</code>.
          </p>
          {(data?.clients ?? []).length > 0 && (
            <table className={styles.table} style={{ marginTop: 16 }}>
              <thead><tr><th>Name</th><th>Plan</th><th>Keys</th><th>Created</th></tr></thead>
              <tbody>
                {data.clients.map((c: any) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.plan}</td>
                    <td>{c.key_count}</td>
                    <td>{c.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </AppShell>
  );
}
