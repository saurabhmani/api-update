'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Button, Input, AlertBanner } from '@/components/ui';
import { userApi, authApi } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';

export default function SettingsPage() {
  const { user }  = useAuth();
  const [prefs,   setPrefs]   = useState<any>({});
  const [pw,      setPw]      = useState({ current:'', newPw:'', confirm:'' });
  const [loading, setLoading] = useState(false);
  const [msg,     setMsg]     = useState<{ text:string; type:'success'|'error' } | null>(null);

  useEffect(() => {
    userApi.preferences().then((d: any) => setPrefs(d.preferences || {})).catch(() => {});
  }, []);

  const flash = (text: string, type: 'success'|'error' = 'success') => {
    setMsg({ text, type }); setTimeout(() => setMsg(null), 4000);
  };

  const savePrefs = async () => {
    setLoading(true);
    try { await userApi.savePrefs(prefs); flash('Preferences saved!'); }
    catch { flash('Failed to save preferences', 'error'); }
    finally { setLoading(false); }
  };

  const changePw = async () => {
    if (!pw.current || !pw.newPw) return flash('All fields required', 'error');
    if (pw.newPw !== pw.confirm) return flash('New passwords do not match', 'error');
    if (pw.newPw.length < 8) return flash('Password must be at least 8 characters', 'error');
    setLoading(true);
    try {
      await authApi.changePassword(pw.current, pw.newPw);
      setPw({ current:'', newPw:'', confirm:'' });
      flash('Password changed successfully!');
    } catch (e: any) { flash(e.data?.error || 'Failed to change password', 'error'); }
    finally { setLoading(false); }
  };

  return (
    <AppShell title="Settings">
      <div className="page" style={{ maxWidth:700 }}>
        <div className="page__header"><div><h1>Settings</h1><p>Manage your account and preferences</p></div></div>

        {msg && <AlertBanner variant={msg.type}>{msg.text}</AlertBanner>}

        {/* Account info */}
        <Card title="Account Info" style={{ marginBottom:20 } as any}>
          <div style={{ display:'grid', gap:10 }}>
            {[['Name', user?.name], ['Email', user?.email], ['Role', user?.role]].map(([l,v]) => (
              <div key={String(l)} style={{ display:'flex', gap:16 }}>
                <div style={{ width:90, fontSize:13, color:'#64748B', fontWeight:500 }}>{l}</div>
                <div style={{ fontSize:14, color:'#0F172A', fontWeight:500 }}>{v || '—'}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Preferences */}
        <Card title="Preferences" style={{ marginBottom:20 } as any}>
          <div style={{ display:'grid', gap:16, marginBottom:20 }}>
            <div className="field" style={{ marginBottom:0 }}>
              <label>Default Dashboard</label>
              <select className="input" style={{ maxWidth:260 }} value={prefs.default_dashboard||'overview'} onChange={e => setPrefs((p:any) => ({ ...p, default_dashboard:e.target.value }))}>
                <option value="overview">Overview</option>
                <option value="watchlist">Watchlist Focus</option>
                <option value="portfolio">Portfolio Focus</option>
              </select>
            </div>
            <div className="field" style={{ marginBottom:0 }}>
              <label>Timezone</label>
              <select className="input" style={{ maxWidth:260 }} value={prefs.timezone||'Asia/Kolkata'} onChange={e => setPrefs((p:any) => ({ ...p, timezone:e.target.value }))}>
                <option value="Asia/Kolkata">IST — Asia/Kolkata</option>
                <option value="UTC">UTC</option>
              </select>
            </div>
          </div>
          <Button onClick={savePrefs} loading={loading}>Save Preferences</Button>
        </Card>

        {/* Change password */}
        <Card title="Change Password">
          <div style={{ display:'grid', gap:4, maxWidth:360 }}>
            <Input label="Current Password" type="password" value={pw.current} onChange={e => setPw(p => ({ ...p, current:e.target.value }))} />
            <Input label="New Password"     type="password" value={pw.newPw}   onChange={e => setPw(p => ({ ...p, newPw:e.target.value }))} />
            <Input label="Confirm Password" type="password" value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm:e.target.value }))} />
          </div>
          <Button style={{ marginTop:16 } as any} onClick={changePw} loading={loading}>Change Password</Button>
        </Card>
      </div>
    </AppShell>
  );
}
