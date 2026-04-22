'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Loading, AlertBanner } from '@/components/ui';
import { RefreshCw, Zap } from 'lucide-react';

export default function AdminSignalRulesPage() {
  const [rules,    setRules]    = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState<number | null>(null);
  const [recomp,   setRecomp]   = useState(false);
  const [msg,      setMsg]      = useState('');

  async function load() {
    setLoading(true);
    try { const d = await fetch('/api/admin/signal-rules').then(r => r.json()); setRules(d.rules || []); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const updateRule = async (id: number, patch: Record<string, unknown>) => {
    setSaving(id);
    try {
      await fetch('/api/admin/signal-rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...patch }) });
      setRules(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
      setMsg('Rule updated. Cache will refresh within 5 minutes.');
    } finally { setSaving(null); setTimeout(() => setMsg(''), 4000); }
  };

  const recompute = async () => {
    setRecomp(true);
    try {
      const d = await fetch('/api/admin/recompute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'all' }) }).then(r => r.json());
      setMsg(`Recomputed: ${d.signals_generated ?? 0} signals, ${d.created ?? 0} setups in ${d.duration_ms}ms`);
    } finally { setRecomp(false); setTimeout(() => setMsg(''), 6000); }
  };

  return (
    <AppShell title="Admin — Signal Rules">
      <div className="page">
        <div className="page__header">
          <div><h1>Signal Rules</h1><p>Adjust weights and enable/disable scoring rules</p></div>
          <Button onClick={recompute} loading={recomp} variant="secondary"><RefreshCw size={13} /> Recompute All</Button>
        </div>

        {msg && <AlertBanner variant="success">{msg}</AlertBanner>}

        <Card style={{ marginBottom: 20 } as any}>
          <p style={{ fontSize: 13, color: '#64748B', lineHeight: 1.6 }}>
            Each rule contributes to the signal confidence score (0–100). Higher weight = more influence. Changes take effect within 5 minutes (Redis cache TTL). Disable rules you don't want contributing to scores.
          </p>
        </Card>

        {loading ? <Loading /> : (
          <div style={{ display: 'grid', gap: 12 }}>
            {rules.map((rule: any) => (
              <Card key={rule.id} compact>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {/* Enable/disable toggle */}
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={e => updateRule(rule.id, { enabled: e.target.checked })}
                    style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#1E3A5F' }}
                  />

                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: rule.enabled ? '#1E3A5F' : '#94A3B8' }}>{rule.label}</div>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>{rule.key} · {rule.rule_type}</div>
                  </div>

                  <Badge variant={rule.enabled ? 'green' : 'gray'}>{rule.enabled ? 'Active' : 'Disabled'}</Badge>

                  {/* Weight input */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: '#64748B', whiteSpace: 'nowrap' }}>Weight:</span>
                    <input
                      type="number"
                      min={0} max={25}
                      value={rule.weight}
                      disabled={!rule.enabled}
                      onChange={e => setRules(prev => prev.map(r => r.id === rule.id ? { ...r, weight: parseInt(e.target.value) } : r))}
                      onBlur={e => updateRule(rule.id, { weight: parseInt(e.target.value) })}
                      style={{
                        width: 56, padding: '4px 8px', border: '1px solid #E2E8F0',
                        borderRadius: 6, fontSize: 14, fontWeight: 700,
                        textAlign: 'center', background: rule.enabled ? '#fff' : '#F8FAFC',
                        color: rule.enabled ? '#0F172A' : '#94A3B8',
                      }}
                    />
                  </div>

                  {saving === rule.id && <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
                </div>

                {/* Weight bar */}
                <div style={{ marginTop: 10, marginLeft: 28 }}>
                  <div style={{ height: 4, background: '#F1F5F9', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(rule.weight / 20) * 100}%`, background: rule.enabled ? '#2E75B6' : '#CBD5E1', borderRadius: 99, transition: 'width 0.3s' }} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
