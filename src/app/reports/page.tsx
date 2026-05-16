'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Loading, Empty } from '@/components/ui';
import { reportsApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { FileText, Download, Plus, RefreshCw } from 'lucide-react';
import type { Report } from '@/types';

const TYPES   = ['portfolio', 'watchlist', 'dashboard'];
const FORMATS = ['csv', 'pdf'];

export default function ReportsPage() {
  const [reports,  setReports]  = useState<Report[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [genning,  setGenning]  = useState(false);
  const [type,     setType]     = useState('portfolio');
  const [format,   setFormat]   = useState('csv');

  async function load() {
    setLoading(true);
    try { const d = await reportsApi.list() as any; setReports(d.reports || []); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const generate = async () => {
    setGenning(true);
    try { await reportsApi.generate(type, format); await load(); }
    catch (e: any) { alert(e.data?.error || 'Failed'); }
    finally { setGenning(false); }
  };

  const statusVariant = (s: string) =>
    s === 'completed' ? 'green' : s === 'failed' ? 'red' : 'orange';

  return (
    <AppShell title="Reports">
      <div className="page">
        <div className="page__header"><div><h1>Reports</h1><p>Generate and download your reports</p></div></div>

        {/* Generator */}
        <Card title="Generate New Report" style={{ marginBottom:20 } as any}>
          <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end' }}>
            <div className="field" style={{ marginBottom:0 }}>
              <label>Report Type</label>
              <select className="input" style={{ width:200 }} value={type} onChange={e => setType(e.target.value)}>
                {TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
              </select>
            </div>
            <div className="field" style={{ marginBottom:0 }}>
              <label>Format</label>
              <select className="input" style={{ width:120 }} value={format} onChange={e => setFormat(e.target.value)}>
                {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
              </select>
            </div>
            <Button onClick={generate} loading={genning}><Plus size={14} /> Generate</Button>
          </div>
        </Card>

        {/* List */}
        <Card flush title="Your Reports" action={<button className="btn btn--ghost btn--sm" onClick={load}><RefreshCw size={13} /></button>}>
          {loading ? <Loading /> : reports.length === 0 ? (
            <Empty icon={FileText} title="No reports yet" description="Generate your first report above." />
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead><tr><th>Name</th><th>Type</th><th>Format</th><th>Status</th><th>Generated</th><th /></tr></thead>
                <tbody>
                  {reports.map(r => (
                    <tr key={r.id}>
                      <td><strong style={{ color:'#1E3A5F' }}>{r.name || `${r.report_type} report`}</strong></td>
                      <td><Badge variant="gray">{r.report_type}</Badge></td>
                      <td><Badge>{r.format?.toUpperCase()}</Badge></td>
                      <td><Badge variant={statusVariant(r.status) as any}>{r.status}</Badge></td>
                      <td style={{ color:'#64748B', fontSize:12 }}>{fmt.datetime(r.created_at)}</td>
                      <td>
                        {r.status === 'completed' && (
                          <button className="btn btn--ghost btn--sm" onClick={() => reportsApi.download(r.id, `${r.report_type}-report.${r.format}`)}>
                            <Download size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
