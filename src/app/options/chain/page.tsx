'use client';
import { useState, useCallback, useEffect } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Button } from '@/components/ui';
import { Activity, AlertTriangle, RefreshCw, Target } from 'lucide-react';
import '@/styles/components/_intelligence.scss';
import '@/styles/components/_ui.scss';

const SOURCE_BACKED_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY'];

const BUILD_COLORS: Record<string, string> = {
  long_buildup:   '#DCFCE7',
  short_buildup:  '#FEE2E2',
  short_covering: '#DBEAFE',
  long_unwinding: '#FEF3C7',
};

interface ChainRow {
  strikePrice: number;
  expiryDate: string;
  ceOi: number;
  ceOiChange: number;
  ceIv: number;
  ceLtp: number;
  ceVolume: number;
  ceBid: number;
  ceAsk: number;
  peOi: number;
  peOiChange: number;
  peIv: number;
  peLtp: number;
  peVolume: number;
  peBid: number;
  peAsk: number;
}

interface OptionSignal {
  id: string;
  label: string;
  direction: 'bullish' | 'bearish' | 'neutral';
  severity: 'high' | 'medium' | 'low';
  optionType: 'CE' | 'PE' | 'CHAIN';
  strike: number | null;
  description: string;
}

interface OptionIntel {
  symbol: string;
  requestedSymbol?: string;
  underlyingValue: number;
  expiryDate: string;
  expiryDates: string[];
  dataSource: 'live' | 'synthetic' | 'unknown';
  generatedAt: string;
  summary: string;
  pcr: number;
  pcrLabel: string;
  maxPain: number;
  expectedMoveUp: number;
  expectedMoveDown: number;
  ivContext: string;
  strongResistance: Array<{ strike: number; strength: string; oi: number; oiChange: number; interpretation: string }>;
  strongSupport: Array<{ strike: number; strength: string; oi: number; oiChange: number; interpretation: string }>;
  buildups: Array<{ strike: number; optionType: 'CE' | 'PE'; buildupType: string; label: string; description: string; oi: number; oiChange: number }>;
  trapZones: Array<{ lower: number; upper: number; description: string; severity: string }>;
  optionSignals: OptionSignal[];
  chain: ChainRow[];
  metrics: {
    totalCeOi: number;
    totalPeOi: number;
    totalCeVolume: number;
    totalPeVolume: number;
    atmStrike: number;
    atmIv: number;
    avgIv: number;
    ivSkew: number;
    highestCeOiStrike: number | null;
    highestPeOiStrike: number | null;
    chainRows: number;
  };
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function fmtPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (Math.abs(n) >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

function sourceBadge(source: OptionIntel['dataSource']) {
  if (source === 'live') return <Badge variant="green">Live</Badge>;
  if (source === 'synthetic') {
    return (
      <Badge variant="orange">
        Estimated chain
      </Badge>
    );
  }
  return <Badge variant="gray">Unknown source</Badge>;
}

function signalVariant(signal: OptionSignal): 'green' | 'red' | 'orange' | 'gray' {
  if (signal.direction === 'bullish') return 'green';
  if (signal.direction === 'bearish') return 'red';
  if (signal.severity === 'medium') return 'orange';
  return 'gray';
}

export default function OptionChainPage() {
  const [symbol,  setSymbol]  = useState('NIFTY');
  const [expiry,  setExpiry]  = useState(0);
  const [customSymbol, setCustomSymbol] = useState('');
  const [intel,   setIntel]   = useState<OptionIntel | null>(null);
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
        setError(
          d.error
          || d.details
          || 'Option chain unavailable — index spot could not be resolved (Yahoo removed; no NSE_INDEX candles). Retry after market data refresh.',
        );
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
  const selectedExpiryIndex = Math.max(0, intel?.expiryDates?.indexOf(intel.expiryDate) ?? expiry);
  const atmWindow = intel?.chain?.filter((row) =>
    Math.abs(row.strikePrice - intel.metrics.atmStrike) <= Math.max(500, intel.underlyingValue * 0.04)
  ) ?? [];
  const visibleChain = atmWindow.length >= 8 ? atmWindow : (intel?.chain ?? []);

  return (
    <AppShell title="Option Intelligence">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Option Intelligence</h1>
            <p>Open interest, PCR, IV, max pain, option chain, and derived option signals</p>
          </div>
          <Button onClick={() => load()} loading={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {SOURCE_BACKED_SYMBOLS.map(s => (
            <button
              key={s}
              className={`btn btn--sm ${symbol === s ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => handleSymbol(s)}
            >
              {s}
            </button>
          ))}
          <span style={{ fontSize: 12, color: '#64748B' }}>
            Presets show only symbols with a fresh local source.
          </span>
          <input
            className="input"
            placeholder="Custom symbol (e.g. RELIANCE)"
            style={{ width: 200, height: 32, fontSize: 13 }}
            value={customSymbol}
            onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
            onKeyDown={e => {
              if (e.key === 'Enter' && customSymbol.trim()) handleSymbol(customSymbol.trim());
            }}
          />
          {customSymbol.trim() && (
            <Button size="sm" variant="secondary" onClick={() => handleSymbol(customSymbol.trim())}>
              Analyse {customSymbol.trim()}
            </Button>
          )}
          {intel?.expiryDates?.length ? (
            <select
              className="input"
              value={selectedExpiryIndex}
              onChange={(e) => {
                const next = Number(e.target.value);
                setExpiry(next);
                load(symbol, next);
              }}
              style={{ width: 150, height: 32, fontSize: 13, marginLeft: 'auto' }}
            >
              {intel.expiryDates.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          ) : null}
        </div>
        </Card>

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
                {intel.requestedSymbol && intel.requestedSymbol !== intel.symbol && (
                  <Badge variant="gray">Resolved from {intel.requestedSymbol}</Badge>
                )}
                {sourceBadge(intel.dataSource)}
                <span style={{ marginLeft: 'auto', fontSize: 20, fontWeight: 800, color: '#1E3A5F' }}>
                  Spot {fmtNum(intel.underlyingValue)}
                </span>
              </div>
              <div style={{ background: '#F8FAFC', borderRadius: 10, padding: '14px 16px', fontSize: 14, lineHeight: 1.7, color: '#334155', borderLeft: '3px solid #2E75B6' }}>
                {intel.summary}
              </div>
              {intel.dataSource === 'synthetic' && (
                <div style={{ marginTop: 10, fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: 10 }}>
                  Live option-chain provider is not configured yet. This screen uses a deterministic estimated chain from spot price, so use it for UI/workflow validation rather than execution.
                </div>
              )}
            </Card>

            {/* PCR + Max Pain + Expected Move */}
            <div className="grid-stats">
              {[
                { label: 'Open Interest', value: `${fmtCompact(intel.metrics.totalPeOi)} PE / ${fmtCompact(intel.metrics.totalCeOi)} CE`, sub: 'Total selected-expiry OI' },
                { label: 'Put/Call Ratio', value: intel.pcr.toFixed(2), sub: intel.pcrLabel },
                { label: 'ATM IV', value: `${intel.metrics.atmIv.toFixed(2)}%`, sub: `Avg IV ${intel.metrics.avgIv.toFixed(2)}% · Skew ${intel.metrics.ivSkew.toFixed(2)}` },
                { label: 'Max Pain', value: fmtNum(intel.maxPain), sub: 'Strike with max writer profit' },
              ].map(({ label, value, sub }) => (
                <div key={label} className="stat-card">
                  <div className="stat-card__label">{label}</div>
                  <div className="stat-card__value" style={{ fontSize: 20 }}>{value}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{sub}</div>
                </div>
              ))}
            </div>

            <div className="grid-stats">
              {[
                { label: 'Expected Up', value: fmtNum(intel.expectedMoveUp), sub: 'ATM IV based upper range' },
                { label: 'Expected Down', value: fmtNum(intel.expectedMoveDown), sub: 'ATM IV based lower range' },
                { label: 'Call Wall', value: fmtNum(intel.metrics.highestCeOiStrike), sub: 'Highest CE open interest' },
                { label: 'Put Wall', value: fmtNum(intel.metrics.highestPeOiStrike), sub: `${intel.metrics.chainRows} strikes in chain` },
              ].map(({ label, value, sub }) => (
                <div key={label} className="stat-card">
                  <div className="stat-card__label">{label}</div>
                  <div className="stat-card__value" style={{ fontSize: 20 }}>{value}</div>
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* Option signals */}
            <Card title="Option Signals" action={<Badge variant="gray">{intel.optionSignals.length}</Badge>}>
              {intel.optionSignals.length === 0 ? (
                <p style={{ fontSize: 13, color: '#64748B' }}>No strong option signal detected for this expiry.</p>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                  {intel.optionSignals.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        border: '1px solid #E2E8F0',
                        borderRadius: 10,
                        padding: 12,
                        background: '#fff',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                        <Badge variant={signalVariant(s)}>{s.direction}</Badge>
                        <strong style={{ fontSize: 13 }}>{s.label}</strong>
                        {s.strike != null && <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748B' }}>{fmtNum(s.strike)}</span>}
                      </div>
                      <p style={{ margin: 0, fontSize: 12, color: '#475569', lineHeight: 1.5 }}>{s.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </Card>

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
                      <div className="oi">OI: {fmtCompact(z.oi)}</div>
                      <div style={{ fontSize: 11, color: z.oiChange > 0 ? '#16A34A' : '#DC2626' }}>
                        {z.oiChange > 0 ? '▲' : '▼'} {fmtCompact(Math.abs(z.oiChange))}
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
                      <div className="oi">OI: {fmtCompact(z.oi)}</div>
                      <div style={{ fontSize: 11, color: z.oiChange > 0 ? '#16A34A' : '#DC2626' }}>
                        {z.oiChange > 0 ? '▲' : '▼'} {fmtCompact(Math.abs(z.oiChange))}
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
                      <div style={{ fontSize: 11, color: '#64748B' }}>{fmtCompact(b.oiChange)}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Full option chain */}
            <Card
              title="Option Chain"
              action={<span style={{ fontSize: 12, color: '#64748B' }}>Centered on ATM {fmtNum(intel.metrics.atmStrike)}</span>}
              flush
            >
              <div style={{ overflowX: 'auto' }}>
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th colSpan={6} style={{ textAlign: 'center', color: '#DC2626' }}>CALLS</th>
                      <th style={{ textAlign: 'center' }}>Strike</th>
                      <th colSpan={6} style={{ textAlign: 'center', color: '#16A34A' }}>PUTS</th>
                    </tr>
                    <tr>
                      <th>OI</th>
                      <th>Chg OI</th>
                      <th>Vol</th>
                      <th>IV</th>
                      <th>Bid/Ask</th>
                      <th>LTP</th>
                      <th>Strike</th>
                      <th>LTP</th>
                      <th>Bid/Ask</th>
                      <th>IV</th>
                      <th>Vol</th>
                      <th>Chg OI</th>
                      <th>OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleChain.map((row) => {
                      const atm = row.strikePrice === intel.metrics.atmStrike;
                      return (
                        <tr key={`${row.expiryDate}-${row.strikePrice}`} style={{ background: atm ? '#EFF6FF' : undefined }}>
                          <td>{fmtCompact(row.ceOi)}</td>
                          <td style={{ color: row.ceOiChange >= 0 ? '#16A34A' : '#DC2626' }}>{fmtCompact(row.ceOiChange)}</td>
                          <td>{fmtCompact(row.ceVolume)}</td>
                          <td>{row.ceIv.toFixed(1)}%</td>
                          <td>{fmtPrice(row.ceBid)} / {fmtPrice(row.ceAsk)}</td>
                          <td style={{ fontWeight: 600 }}>{fmtPrice(row.ceLtp)}</td>
                          <td style={{ textAlign: 'center', fontWeight: 800, color: atm ? '#1D4ED8' : '#334155' }}>
                            {fmtNum(row.strikePrice)}
                          </td>
                          <td style={{ fontWeight: 600 }}>{fmtPrice(row.peLtp)}</td>
                          <td>{fmtPrice(row.peBid)} / {fmtPrice(row.peAsk)}</td>
                          <td>{row.peIv.toFixed(1)}%</td>
                          <td>{fmtCompact(row.peVolume)}</td>
                          <td style={{ color: row.peOiChange >= 0 ? '#16A34A' : '#DC2626' }}>{fmtCompact(row.peOiChange)}</td>
                          <td>{fmtCompact(row.peOi)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>

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
                <Activity size={16} color="#2E75B6" />
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
