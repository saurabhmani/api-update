'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { Play, RefreshCw, Newspaper, Zap, ShieldAlert, BarChart3, Clock, CheckCircle, XCircle, Loader } from 'lucide-react';

interface JobRun { job_name: string; status: string; duration_ms: number; counts_json: string; error_msg: string | null; run_at: string; }

const JOBS = [
  { id: 'news',          label: 'News Pipeline',        desc: 'Ingest + score + compute impact', endpoint: '/api/news-engine', method: 'POST', body: '{}', icon: Newspaper },
  { id: 'rescore',       label: 'Re-score Events',      desc: 'Score unscored events (48h)',     endpoint: '/api/news-engine', method: 'POST', body: '{"action":"rescore"}', icon: RefreshCw },
  { id: 'calibrate',     label: 'News Calibration',     desc: 'Calibrate by category/source/sentiment', endpoint: '/api/news-engine', method: 'POST', body: '{"action":"calibrate"}', icon: BarChart3 },
  { id: 'evaluate',      label: 'Evaluate Outcomes',    desc: 'Grade signal outcomes (30d window)', endpoint: '/api/signal-engine/feedback/evaluate', method: 'POST', body: '{}', icon: Zap },
  { id: 'manipulation',  label: 'Manipulation Scan',    desc: 'Run surveillance on full universe', endpoint: '/api/manipulation/run', method: 'POST', body: '{}', icon: ShieldAlert },
];

const StatusIcon = ({ status }: { status: string }) => {
  if (status === 'success') return <CheckCircle size={14} style={{ color:'#059669' }} />;
  if (status === 'failed') return <XCircle size={14} style={{ color:'#DC2626' }} />;
  return <Clock size={14} style={{ color:'#5A6A7E' }} />;
};

export default function PipelinePage() {
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, any>>({});

  const loadRuns = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/signal-engine/calibration?days=7');
      const json = await res.json();
      setRuns(json.learningJobRuns ?? []);
    } catch { /* empty */ }
    setLoading(false);
  };

  useEffect(() => { loadRuns(); }, []);

  const triggerJob = async (job: typeof JOBS[number]) => {
    setRunning(job.id);
    setResults(r => ({ ...r, [job.id]: null }));
    try {
      const res = await fetch(job.endpoint, { method: job.method, headers: { 'Content-Type': 'application/json' }, body: job.body });
      const json = await res.json();
      setResults(r => ({ ...r, [job.id]: { ok: res.ok, data: json } }));
      await loadRuns();
    } catch (e: any) {
      setResults(r => ({ ...r, [job.id]: { ok: false, error: e.message } }));
    }
    setRunning(null);
  };

  return (
    <AppShell>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <h1 style={{ fontSize:'1.5rem', fontWeight:800, background:'linear-gradient(135deg,#2563EB,#00C9FF)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>
          Pipeline Control
        </h1>
        <button onClick={loadRuns} style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 16px', borderRadius:8, fontSize:13, fontWeight:600, background:'#0B1F3A', color:'white', border:'none', cursor:'pointer' }}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* Job Triggers */}
      <div style={{ display:'grid', gap:16, gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', marginBottom:32 }}>
        {JOBS.map(job => {
          const Icon = job.icon;
          const isRunning = running === job.id;
          const result = results[job.id];
          return (
            <Card key={job.id}>
              <div style={{ padding:20 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                  <Icon size={18} style={{ color:'#0E7490' }} />
                  <span style={{ fontWeight:800, fontSize:14 }}>{job.label}</span>
                </div>
                <p style={{ fontSize:12, color:'#5A6A7E', marginBottom:14, lineHeight:1.5 }}>{job.desc}</p>
                <button
                  onClick={() => triggerJob(job)}
                  disabled={isRunning}
                  style={{
                    display:'flex', alignItems:'center', gap:6, padding:'8px 20px', borderRadius:8,
                    fontSize:13, fontWeight:700, background:isRunning ? '#E1E8F0' : '#0B1F3A',
                    color:isRunning ? '#5A6A7E' : 'white', border:'none', cursor:isRunning ? 'not-allowed' : 'pointer',
                    transition:'all 150ms', width:'100%', justifyContent:'center',
                  }}
                >
                  {isRunning ? <><Loader size={14} style={{ animation:'spin 0.9s linear infinite' }} /> Running...</> : <><Play size={14} /> Run Now</>}
                </button>
                {result && (
                  <div style={{ marginTop:10, fontSize:11, padding:'6px 10px', borderRadius:6, background:result.ok ? '#F0FDF4' : '#FEF2F2', color:result.ok ? '#065F46' : '#991B1B', lineHeight:1.5 }}>
                    {result.ok ? 'Completed successfully' : `Error: ${result.error ?? result.data?.error ?? 'Unknown'}`}
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Recent Job Runs */}
      <div style={{ marginBottom:16, display:'flex', alignItems:'center', gap:8, paddingBottom:12, borderBottom:'2px solid #CFFAFE' }}>
        <Clock size={18} style={{ color:'#0E7490' }} />
        <span style={{ fontSize:16, fontWeight:700, background:'linear-gradient(135deg,#2563EB,#00C9FF)', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent' }}>Recent Job Runs</span>
      </div>

      {loading ? <Loading text="Loading job history..." /> : (
        <Card>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, color:'#5A6A7E', fontWeight:700, textTransform:'uppercase', letterSpacing:0.5, borderBottom:'2px solid #E1E8F0' }}>Job</th>
                  <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, color:'#5A6A7E', fontWeight:700, textTransform:'uppercase', letterSpacing:0.5, borderBottom:'2px solid #E1E8F0' }}>Status</th>
                  <th style={{ padding:'8px 12px', textAlign:'right', fontSize:11, color:'#5A6A7E', fontWeight:700, textTransform:'uppercase', letterSpacing:0.5, borderBottom:'2px solid #E1E8F0' }}>Duration</th>
                  <th style={{ padding:'8px 12px', textAlign:'right', fontSize:11, color:'#5A6A7E', fontWeight:700, textTransform:'uppercase', letterSpacing:0.5, borderBottom:'2px solid #E1E8F0' }}>Run At</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={i} style={{ borderBottom:'1px solid rgba(225,232,240,0.5)' }}>
                    <td style={{ padding:'8px 12px', fontSize:13, fontWeight:700 }}>{r.job_name}</td>
                    <td style={{ padding:'8px 12px', fontSize:13 }}>
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
                        <StatusIcon status={r.status} />
                        <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', color:r.status === 'success' ? '#059669' : '#DC2626' }}>{r.status}</span>
                      </span>
                    </td>
                    <td style={{ padding:'8px 12px', fontSize:12, textAlign:'right', fontFamily:'monospace', color:'#5A6A7E' }}>{r.duration_ms}ms</td>
                    <td style={{ padding:'8px 12px', fontSize:12, textAlign:'right', color:'#8B9DB0' }}>{new Date(r.run_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </AppShell>
  );
}
