'use client';

import { Activity, Shield, TrendingUp, Wallet, Target, Gauge } from 'lucide-react';
import { StatCard, Card, Badge, Loading } from '@/components/ui';
import { useTrustDashboard } from '@/hooks/trust/useTrustDashboard';
import { fmt } from '@/lib/utils';
import { categoryDisplayLabel } from '@/lib/trust-layer/mappers/regimeMapper';

export function TrustDashboardPanel() {
  const { data, isLoading, error } = useTrustDashboard();

  if (isLoading) return <Loading text="Loading quant dashboard…" />;
  if (error || !data) {
    return <Card title="Quant Dashboard"><p style={{ color: '#DC2626' }}>Unable to load dashboard metrics.</p></Card>;
  }

  const trustVariant =
    data.trustScore.label === 'HIGH' ? 'green'
    : data.trustScore.label === 'MEDIUM' ? 'orange'
    : data.trustScore.label === 'LOW' ? 'red'
    : 'gray';

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 20 }}>
        <StatCard label="Active Signals" value={data.activeSignals} icon={Target} iconVariant="blue" />
        <StatCard label="Running Strategies" value={data.runningStrategies} icon={Activity} iconVariant="green" />
        <StatCard
          label="Today's P&L"
          value={data.hasPortfolio ? fmt.currency(data.todayPnl) : 'N/A'}
          change={data.hasPortfolio ? data.todayPnlPct : undefined}
          icon={Wallet}
          iconVariant={data.hasPortfolio ? (data.todayPnl >= 0 ? 'green' : 'red') : 'blue'}
        />
        <StatCard
          label="Win Rate (90D)"
          value={`${data.winRate}%`}
          icon={TrendingUp}
          iconVariant="blue"
        />
        <StatCard
          label="Risk Exposure"
          value={data.hasPortfolio ? `${data.riskExposure}` : 'N/A'}
          icon={Shield}
          iconVariant={
            !data.hasPortfolio ? 'blue' :
            data.riskSeverity === 'critical' ? 'red' :
            data.riskSeverity === 'warning' ? 'orange' :
            'blue'
          }
        />
        <StatCard
          label="Market Regime"
          value={categoryDisplayLabel(data.marketRegime.category)}
          icon={Gauge}
          iconVariant="orange"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Market Summary">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.9rem' }}>
            <div><strong>Benchmark:</strong> {data.marketSummary.benchmarkSymbol}</div>
            <div><strong>Session:</strong> {data.marketSummary.sessionLabel}</div>
            <div>
              <strong>Status:</strong>{' '}
              <Badge variant={data.marketSummary.marketOpen ? 'green' : 'gray'}>
                {data.marketSummary.marketOpen ? 'Open' : 'Closed'}
              </Badge>
            </div>
            <div><strong>Regime:</strong> {data.marketRegime.label} ({data.marketRegime.confidence}% confidence)</div>
          </div>
        </Card>

        <Card
          title="Trust Score"
          action={<Badge variant={trustVariant}>{data.trustScore.label}</Badge>}
        >
          <div style={{ fontSize: '2rem', fontWeight: 700, marginBottom: 8 }}>
            {data.trustScore.label === 'INSUFFICIENT_DATA' ? 'N/A' : `${data.trustScore.score}%`}
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.85rem', color: '#64748B' }}>
            {data.trustScore.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
