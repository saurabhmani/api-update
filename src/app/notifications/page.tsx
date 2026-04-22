'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Button, Loading, Empty } from '@/components/ui';
import { notificationsApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Bell, CheckCheck } from 'lucide-react';
import type { Notification } from '@/types';

export default function NotificationsPage() {
  const [items,   setItems]   = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { const d = await notificationsApi.list() as any; setItems(d.notifications || []); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const markRead = async (id: number) => {
    await notificationsApi.markRead(id);
    setItems(prev => prev.map(n => n.id === id ? { ...n, is_read: true } : n));
  };

  const markAll = async () => {
    await notificationsApi.markAll();
    setItems(prev => prev.map(n => ({ ...n, is_read: true })));
  };

  const unread = items.filter(n => !n.is_read).length;

  return (
    <AppShell title="Notifications">
      <div className="page">
        <div className="page__header">
          <div><h1>Notifications</h1><p>{unread} unread</p></div>
          {unread > 0 && <Button variant="secondary" size="sm" onClick={markAll}><CheckCheck size={14} /> Mark all read</Button>}
        </div>

        <Card flush>
          {loading ? <Loading /> : items.length === 0 ? (
            <Empty icon={Bell} title="All caught up!" description="No notifications right now." />
          ) : items.map(n => (
            <div
              key={n.id}
              onClick={() => !n.is_read && markRead(n.id)}
              style={{
                display:'flex', alignItems:'flex-start', gap:14, padding:'14px 20px',
                borderBottom:'1px solid #F1F5F9', cursor: n.is_read ? 'default' : 'pointer',
                background: n.is_read ? '#fff' : '#EFF6FF', transition:'background 0.15s',
              }}
            >
              <div style={{ width:8, height:8, borderRadius:'50%', marginTop:6, flexShrink:0, background: n.is_read ? '#E2E8F0' : '#2E75B6' }} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight: n.is_read ? 400 : 600, color:'#0F172A' }}>{n.message}</div>
                <div style={{ fontSize:12, color:'#94A3B8', marginTop:3 }}>{fmt.ago(n.created_at)}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </AppShell>
  );
}
