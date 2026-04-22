'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, AlertBanner } from '@/components/ui';
import { useKiteStatus } from '@/hooks/useKiteStatus';
import { Zap, CheckCircle, AlertTriangle, Clock, Wifi, WifiOff, RefreshCw } from 'lucide-react';

export default function ZerodhaConnectPage() {
  const { status, phase, connectKite, refresh } = useKiteStatus();
  const [diagnose, setDiagnose] = useState<any>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  const isConnected = status?.kiteAuth === 'ok' && status.connected;
  const isExpired   = status?.kiteAuth === 'expired';
  const needsLogin  = status?.kiteAuth === 'login_required' || isExpired;

  const ageH = Math.floor((status?.tokenAgeMinutes ?? 0) / 60);
  const ageM = (status?.tokenAgeMinutes ?? 0) % 60;
  const ageFmt = status?.tokenAgeMinutes != null
    ? `${ageH}h ${ageM}m` : '—';

  const runDiagnose = async () => {
    setDiagLoading(true);
    try {
      const res = await fetch('/api/kite/diagnose', { cache: 'no-store' });
      const d = await res.json();
      setDiagnose(d);
    } catch { setDiagnose({ error: 'Could not reach diagnose endpoint' }); }
    finally { setDiagLoading(false); }
  };

  useEffect(() => {
    // Run diagnose once on mount so status is immediately visible
    runDiagnose();
  }, []);

  return (
    <AppShell title="Zerodha — Live Data Connection">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>
              <Zap size={20} style={{ verticalAlign: -3, marginRight: 8 }} />
              Zerodha Live Data
            </h1>
            <p>Connect Zerodha every morning before 09:15 IST for real-time prices</p>
          </div>
          <Button variant="secondary" onClick={refresh} loading={phase === 'loading'}>
            <RefreshCw size={14} /> Refresh Status
          </Button>
        </div>

        {/* ── Top alert banner ──────────────────────────── */}
        {needsLogin && status && (
          <AlertBanner variant="warning" style={{ marginBottom: 20 }}>
            {isExpired
              ? 'Kite token has expired. Connect now to restore live prices.'
              : 'Kite login required. Live prices are currently delayed (Yahoo fallback active).'}
          </AlertBanner>
        )}
        {isConnected && (
          <AlertBanner variant="success" style={{ marginBottom: 20 }}>
            Zerodha connected — live prices streaming for {status?.subscribedCount ?? 0} symbols.
          </AlertBanner>
        )}

        {/* ── Connection status card ────────────────────── */}
        <Card style={{ marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 16 }}>Connection Status</h3>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 16 }}>
            <Badge variant={isConnected ? 'green' : isExpired ? 'orange' : 'red'}>
              {isConnected ? '● Connected' : isExpired ? '● Token Expired' : '● Login Required'}
            </Badge>

            {(status?.subscribedCount ?? 0) > 0 && (
              <Badge variant="default">{status!.subscribedCount} symbols live</Badge>
            )}

            {status?.marketIsOpen
              ? <Badge variant="green">Market Open</Badge>
              : <Badge variant="gray">{status?.marketLabel ?? 'Market Closed'}</Badge>}

            {status?.tokenAgeMinutes != null && (
              <span style={{ fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 4 }}>
                <Clock size={13} /> Token age: {ageFmt}
              </span>
            )}
          </div>

          {!isConnected ? (
            <div>
              <Button variant="primary" onClick={connectKite} style={{ marginBottom: 8 }}>
                <Zap size={14} /> Connect Zerodha
              </Button>
              <p style={{ fontSize: 12, color: '#94A3B8', margin: 0 }}>
                Opens Kite login in this tab. Redirects back automatically. Takes under 60 seconds.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#16A34A', fontSize: 14 }}>
              <CheckCircle size={16} />
              Live data active — {status?.subscribedCount ?? 0} symbols streaming to all pages.
            </div>
          )}
        </Card>

        {/* ── Daily checklist ───────────────────────────── */}
        <Card style={{ marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 12 }}>Daily Morning Checklist</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Open this page before 09:10 IST', isConnected],
              ['Status shows Token Expired or Login Required', true],
              ['Click Connect Zerodha', isConnected],
              ['Log in on Kite (10–20 seconds)', isConnected],
              ['Status turns green — live prices start at 09:15', isConnected],
            ].map(([step, done], i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ color: done ? '#16A34A' : '#94A3B8', fontWeight: 700 }}>
                  {done ? '✓' : `${i + 1}.`}
                </span>
                <span style={{ color: done ? '#16A34A' : '#374151' }}>{step as string}</span>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 11, color: '#94A3B8', marginTop: 12, marginBottom: 0 }}>
            Token is valid until approximately 06:00 IST next day.
          </p>
        </Card>

        {/* ── Pipeline health ───────────────────────────── */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontWeight: 700, margin: 0 }}>Pipeline Health</h3>
            <Button variant="secondary" onClick={runDiagnose} loading={diagLoading}>
              <RefreshCw size={13} /> Run Diagnose
            </Button>
          </div>

          {diagnose ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              {[
                ['WebSocket state',   diagnose.wsState ?? '—'],
                ['Kite auth',         diagnose.kiteAuth ?? '—'],
                ['Subscribed symbols', diagnose.subscribed ?? 0],
                ['Signal symbols covered', diagnose.signalSymbolsSubscribed ?? 0],
                ['Ticks cached',      diagnose.ticksCached ?? 0],
                ['Last error',        diagnose.lastError ?? 'None'],
              ].map(([label, val]) => (
                <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#64748B' }}>{label}</span>
                  <span style={{ fontWeight: 600, color: '#1E3A5F' }}>{String(val)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: '#94A3B8' }}>Click Run Diagnose to check pipeline health.</p>
          )}
        </Card>

        {/* ── Quick reference ───────────────────────────── */}
        <Card>
          <h3 style={{ fontWeight: 700, marginBottom: 12 }}>Quick Reference</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#64748B' }}>
            <div><strong>Kite redirect URL</strong> (set in kite.trade/developers):</div>
            <div style={{ fontFamily: 'monospace', background: '#F1F5F9', padding: '4px 8px', borderRadius: 4 }}>
              {(process.env.NEXT_PUBLIC_APP_URL ?? 'https://yourdomain.com') + '/api/kite/callback'}
            </div>
            <div style={{ marginTop: 8 }}><strong>Status API:</strong> GET /api/kite/status</div>
            <div><strong>Verify API:</strong> GET /api/kite/verify (Kite vs Yahoo price check)</div>
            <div><strong>Diagnose API:</strong> GET /api/kite/diagnose (full pipeline health)</div>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
