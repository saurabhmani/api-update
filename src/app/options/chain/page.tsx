'use client';
import { useState, useCallback, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { TrendingUp, TrendingDown, AlertTriangle, Target } from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

const BUILD_COLORS: Record<string, string> = {
  long_buildup:   '#DCFCE7',
  short_buildup:  '#FEE2E2',
  short_covering: '#DBEAFE',
  long_unwinding: '#FEF3C7',
};

export default function OptionChainPage() {
  const [symbol,  setSymbol]  = useState('NIFTY');
  const [expiry,  setExpiry]  = useState(0);
  const [intel,   setIntel]   = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // Auto-refresh every 10 seconds with the current symbol/expiry
  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 10_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, expiry]);

  const load = useCallback(async (sym = symbol, exp = expiry) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/options/intelligence?symbol=${encodeURIComponent(sym)}&expiry=${exp}`, { cache: 'no-store' });
      const d   = await res.json();
      if (!res.ok || !d.intelligence) {
        setError(d.error || 'Option chain unavailable. Market may be closed or upstream is unreachable.');
        setIntel(null);
      } else {
        setIntel(d.intelligence);
      }
    } catch {
      setError('Network error — could not reach the server.');
      setIntel(null);
    } finally { setLoading(false); }
  }, [symbol, expiry]);

  const handleSymbol = (sym: string) => { setSymbol(sym); setExpiry(0); load(sym, 0); };

  return (
    <AppShell title="Option Intelligence">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Option Intelligence</h1>
            <p>Support/Resistance zones · Build-ups · Traps · Max Pain · Expected Move</p>
          </div>
          <Button onClick={() => load()}>Analyse</Button>
        </div>

        {/* Symbol selector */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {SYMBOLS.map(s => (
            <button
              key={s}
              className={`btn btn--sm ${symbol === s ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => handleSymbol(s)}
            >
              {s}
            </button>
          ))}
          <input
            className="input"
            placeholder="Custom symbol (e.g. RELIANCE)"
            style={{ width: 200, height: 32, fontSize: 13 }}
            onKeyDown={e => { if (e.key === 'Enter') handleSymbol((e.target as HTMLInputElement).value.toUpperCase()); }}
          />
        </div>

        {loading ? <Loading text="Fetching option chain…" /> : error ? (
          <Empty icon={AlertTriangle} title="Option chain unavailable" description={error} action={<Button onClick={() => load()}>Retry {symbol}</Button>} />
        ) : !intel ? (
          <Empty icon={Target} title="Select a symbol to analyse" description="Click Analyse to load option chain intelligence." action={<Button onClick={() => load()}>Analyse {symbol}</Button>} />
        ) : (
          <div style={{ display: 'grid', gap: 20 }}>

            {/* Summary card */}
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <h3 style={{ fontWeight: 700, fontSize: 18 }}>{intel.symbol}</h3>
                <Badge>{intel.expiryDate}</Badge>
                {intel.dataSource === 'synthetic' && (
                  <Badge variant="gray" style={{ fontSize: 10, background: '#FEF3C7', color: '#92400E' }}>
                    Estimated (live feed unavailable)
                  </Badge>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 800, color: '#1E3A5F' }}>
                  ₹{intel.underlyingValue?.toLocaleString('en-IN')}
                </span>
              </div>
              <div style={{ background: '#F8FAFC', borderRadius: 10, padding: '14px 16px', fontSize: 14, lineHeight: 1.7, color: '#334155', borderLeft: '3px solid #2E75B6' }}>
                {intel.summary}
              </div>
            </Card>

            {/* PCR + Max Pain + Expected Move */}
            <div className="grid-stats">
              {[
                { label: 'PCR', value: intel.pcr, sub: intel.pcrLabel },
                { label: 'Max Pain', value: `₹${intel.maxPain?.toLocaleString('en-IN')}`, sub: 'Strike with max option writers profit' },
                { label: 'Expected Up', value: `₹${intel.expectedMoveUp?.toLocaleString('en-IN')}`, sub: 'Upside target (ATM IV-based)' },
                { label: 'Expected Down', value: `₹${intel.expectedMoveDown?.toLocaleString('en-IN')}`, sub: 'Downside target' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="stat-card">
                  <div className="stat-card__label">{label}</div>
                  <div className="stat-card__value" style={{ fontSize: 20 }}>{value}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* Resistance + Support zones */}
            <div className="grid-2">
              <Card title="Call Writing — Resistance Zones">
                {intel.strongResistance?.map((z: any, i: number) => (
                  <div key={i} className="option-intel__zone-row">
                    <div>
                      <span className="strike" style={{ color: '#DC2626' }}>₹{z.strike.toLocaleString('en-IN')}</span>
                      <Badge variant="red" style={{ marginLeft: 8 }}>{z.strength}</Badge>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="oi">OI: {(z.oi / 1000).toFixed(0)}K</div>
                      <div style={{ fontSize: 11, color: z.oiChange > 0 ? '#16A34A' : '#DC2626' }}>
                        {z.oiChange > 0 ? '▲' : '▼'} {Math.abs(z.oiChange / 1000).toFixed(0)}K
                      </div>
                    </div>
                  </div>
                ))}
                {intel.strongResistance?.[0] && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#64748B', background: '#FEF2F2', borderRadius: 8, padding: 10 }}>
                    {intel.strongResistance[0].interpretation}
                  </div>
                )}
              </Card>

              <Card title="Put Writing — Support Zones">
                {intel.strongSupport?.map((z: any, i: number) => (
                  <div key={i} className="option-intel__zone-row">
                    <div>
                      <span className="strike" style={{ color: '#16A34A' }}>₹{z.strike.toLocaleString('en-IN')}</span>
                      <Badge variant="green" style={{ marginLeft: 8 }}>{z.strength}</Badge>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div className="oi">OI: {(z.oi / 1000).toFixed(0)}K</div>
                      <div style={{ fontSize: 11, color: z.oiChange > 0 ? '#16A34A' : '#DC2626' }}>
                        {z.oiChange > 0 ? '▲' : '▼'} {Math.abs(z.oiChange / 1000).toFixed(0)}K
                      </div>
                    </div>
                  </div>
                ))}
                {intel.strongSupport?.[0] && (
                  <div style={{ marginTop: 10, fontSize: 12, color: '#64748B', background: '#F0FDF4', borderRadius: 8, padding: 10 }}>
                    {intel.strongSupport[0].interpretation}
                  </div>
                )}
              </Card>
            </div>

            {/* Build-ups */}
            {intel.buildups?.length > 0 && (
              <Card title="OI Build-Up Activity">
                <div style={{ display: 'grid', gap: 6 }}>
                  {intel.buildups.slice(0, 8).map((b: any, i: number) => (
                    <div key={i} className="option-intel__buildup" style={{ background: BUILD_COLORS[b.buildupType] || '#F8FAFC' }}>
                      <div style={{ fontWeight: 700, minWidth: 60, fontSize: 13 }}>₹{b.strike}</div>
                      <Badge variant="gray">{b.optionType}</Badge>
                      <div style={{ flex: 1, fontSize: 12 }}>
                        <strong>{b.label}</strong> — {b.description}
                      </div>
                      <div style={{ fontSize: 11, color: '#64748B' }}>{(b.oiChange / 1000).toFixed(0)}K</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Trap zones */}
            {intel.trapZones?.length > 0 && (
              <Card>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <AlertTriangle size={16} color="#D97706" />
                  <h3 style={{ fontWeight: 700 }}>Trap Zone Detected</h3>
                </div>
                {intel.trapZones.map((t: any, i: number) => (
                  <div key={i} className="option-intel__trap">
                    <strong>Range: ₹{t.lower} – ₹{t.upper}</strong>
                    <div style={{ marginTop: 6 }}>{t.description}</div>
                  </div>
                ))}
              </Card>
            )}

            {/* IV Context */}
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <TrendingUp size={16} color="#2E75B6" />
                <h3 style={{ fontWeight: 700 }}>Volatility Context</h3>
              </div>
              <p style={{ fontSize: 14, color: '#334155', lineHeight: 1.6 }}>{intel.ivContext}</p>
            </Card>

          </div>
        )}
      </div>
    </AppShell>
  );
}
