'use client';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEventStream } from '@/hooks/useEventStream';
import { useAuth } from '@/hooks/useAuth';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { fmt } from '@/lib/utils';
import { Target, RefreshCw } from 'lucide-react';
import '@/styles/components/_intelligence.scss';

const TRADE_SETUP_QUERY_KEY = ['trade-setup', 'active'] as const;
const TRADE_SETUP_SEED_KEY = ['trade-setup', 'seed-symbol'] as const;

function SignalChip({ dir }: { dir: string }) {
  return <span className={`signal-chip signal-chip--${dir}`}>{dir}</span>;
}

export default function TradeSetupsPage() {
  const { user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const automaticIdentityRef = useRef<string | null>(null);
  const queryKey = TRADE_SETUP_QUERY_KEY;

  const tradeSetupQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/trade-setups?action=active', {
        cache: 'no-store',
        signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to load trade setups');
      return payload as { setups: any[]; count: number; note?: string };
    },
    enabled: Boolean(!authLoading && user),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const setups = tradeSetupQuery.data?.setups ?? [];
  const seedSymbolQuery = useQuery({
    queryKey: TRADE_SETUP_SEED_KEY,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/rankings?limit=1&page=1', { signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Unable to select a ranked symbol');
      const row = payload.data?.[0];
      return String(row?.tradingsymbol ?? row?.symbol ?? '').toUpperCase();
    },
    enabled: Boolean(
      !authLoading &&
      user &&
      tradeSetupQuery.isSuccess &&
      setups.length === 0
    ),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const targetSymbol = String(
    setups[0]?.tradingsymbol ?? seedSymbolQuery.data ?? '',
  ).toUpperCase();

  const generateMutation = useMutation({
    mutationKey: ['trade-setup', 'generate', targetSymbol, 'auto', 'swing'],
    mutationFn: async ({ force, symbol }: { force: boolean; symbol: string }) => {
      const response = await fetch('/api/trade-setups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          force,
          symbol,
          strategyId: 'auto',
          timeframe: 'swing',
        }),
      });
      const payload = await response.json();
      if (!response.ok && response.status !== 202) {
        throw new Error(payload.error || 'Trade setup generation failed');
      }
      return payload as { note?: string; generationStatus?: string };
    },
    onSuccess: async (payload) => {
      if (payload.note) setNote(payload.note);
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const automaticIdentity = user && targetSymbol
    ? `${user.id}:${targetSymbol}:auto:swing`
    : null;

  useEffect(() => {
    if (
      !automaticIdentity ||
      automaticIdentityRef.current === automaticIdentity ||
      !tradeSetupQuery.isSuccess ||
      setups.length > 0
    ) return;

    automaticIdentityRef.current = automaticIdentity;
    generateMutation.mutate({ force: false, symbol: targetSymbol });
  }, [
    automaticIdentity,
    tradeSetupQuery.isSuccess,
    setups.length,
    targetSymbol,
    generateMutation,
  ]);

  useEffect(() => {
    if (
      generateMutation.data?.generationStatus !== 'in_progress' ||
      setups.length > 0
    ) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        queryClient.invalidateQueries({ queryKey });
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [
    generateMutation.data?.generationStatus,
    queryClient,
    queryKey,
    setups.length,
  ]);

  // Refresh when a new signal is generated
  const { lastEvent } = useEventStream();
  useEffect(() => {
    if (lastEvent?.type === 'signal:new' || lastEvent?.type === 'pipeline:status') {
      queryClient.invalidateQueries({ queryKey });
    }
  }, [lastEvent, queryClient, queryKey]);

  const recompute = () => {
    if (!targetSymbol) return;
    setNote(null);
    generateMutation.mutate({ force: true, symbol: targetSymbol });
  };

  const error = setups.length === 0
    ? tradeSetupQuery.error ?? seedSymbolQuery.error ?? generateMutation.error
    : null;
  const loading = authLoading || tradeSetupQuery.isLoading ||
    (setups.length === 0 && seedSymbolQuery.isLoading) ||
    (setups.length === 0 && generateMutation.isPending);

  return (
    <AppShell title="Trade Setups">
      <div className="page">
        <div className="page__header">
          <div><h1>Trade Setups</h1><p>Rule-based actionable setups with entry, SL and targets</p></div>
          <Button variant="secondary" onClick={recompute} loading={generateMutation.isPending} disabled={!targetSymbol}><RefreshCw size={13} /> Regenerate</Button>
        </div>

        {note && (
          <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#166534' }}>
            {note}
          </div>
        )}

        {loading ? <Loading /> : error ? (
          <Empty
            icon={Target}
            title="Trade setups could not be loaded"
            description={error instanceof Error ? error.message : 'Please retry the request.'}
            action={
              <Button onClick={() => {
                if (generateMutation.error) {
                  generateMutation.mutate({ force: false, symbol: targetSymbol });
                } else {
                  tradeSetupQuery.refetch();
                }
              }}>
                <RefreshCw size={13} /> Retry
              </Button>
            }
          />
        ) : setups.length === 0 ? (
          <Empty icon={Target} title="No active setups" description="No setup currently passes the institutional gates. You can retry generation for the highest-ranked symbol using the latest available market data." action={<Button onClick={recompute} loading={generateMutation.isPending} disabled={!targetSymbol}><RefreshCw size={13} /> Regenerate</Button>} />
        ) : (
          <div className="grid-3">
            {setups.map((s: any) => (
              <div key={s.id} className={`setup-card setup-card--${s.direction}`}>
                <div className="setup-card__header">
                  <div>
                    <div className="setup-card__symbol">{s.tradingsymbol}</div>
                    <div style={{ fontSize:12, color:'#64748B' }}>{s.exchange}</div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                    <SignalChip dir={s.direction} />
                    <Badge variant="gray">{s.timeframe || 'swing'}</Badge>
                  </div>
                </div>

                <div className="setup-card__levels">
                  <div className="setup-card__level setup-card__level--entry">
                    <div className="label">Entry</div>
                    <div className="value">{fmt.currency(s.entry_price)}</div>
                  </div>
                  <div className="setup-card__level setup-card__level--sl">
                    <div className="label">Stop Loss</div>
                    <div className="value">{fmt.currency(s.stop_loss)}</div>
                  </div>
                  <div className="setup-card__level setup-card__level--t1">
                    <div className="label">Target 1</div>
                    <div className="value">{fmt.currency(s.target1)}</div>
                  </div>
                </div>

                {s.target2 && (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'#64748B', marginBottom:8 }}>
                    <span>Target 2: <strong>{fmt.currency(s.target2)}</strong></span>
                    {s.risk_reward && <span>R:R <strong>1:{s.risk_reward}</strong></span>}
                  </div>
                )}

                <div className="setup-card__meta">
                  <span>Confidence: <strong style={{ color: s.confidence >= 70 ? '#16A34A' : s.confidence >= 55 ? '#D97706' : '#DC2626' }}>{s.confidence}%</strong></span>
                  {s.expires_at && <span>Valid till {new Date(s.expires_at).toLocaleDateString('en-IN')}</span>}
                </div>

                {s.reason && <div className="setup-card__reason">{s.reason}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
