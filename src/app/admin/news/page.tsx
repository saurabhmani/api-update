'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Button, Modal, Input, Loading, Empty, AlertBanner } from '@/components/ui';
import { newsApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Newspaper, Plus, Trash2, Edit2 } from 'lucide-react';

const empty = { title:'', summary:'', content:'', thumbnail:'', is_published:false, is_featured:false };

export default function AdminNewsPage() {
  const [articles, setArticles] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [modal,    setModal]    = useState(false);
  const [editing,  setEditing]  = useState<any | null>(null);
  const [form,     setForm]     = useState(empty);
  const [saving,   setSaving]   = useState(false);
  const [error,    setError]    = useState('');

  async function load() {
    setLoading(true);
    // Admin fetches all articles including drafts
    try { const d = await newsApi.list('') as any; setArticles(d.news || []); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm(empty); setError(''); setModal(true); };
  const openEdit   = (a: any) => { setEditing(a); setForm({ title:a.title, summary:a.summary||'', content:a.content||'', thumbnail:a.thumbnail||'', is_published:a.is_published, is_featured:a.is_featured }); setError(''); setModal(true); };

  const save = async () => {
    if (!form.title) return setError('Title is required');
    setSaving(true);
    try {
      if (editing) { await newsApi.update({ id:editing.id, ...form }); }
      else { await newsApi.create(form); }
      setModal(false); await load();
    } catch (e: any) { setError(e.data?.error || 'Failed'); }
    finally { setSaving(false); }
  };

  const del = async (id: number) => {
    if (!confirm('Delete this article?')) return;
    await newsApi.delete(id); setArticles(prev => prev.filter(a => a.id !== id));
  };

  return (
    <AppShell title="Admin — News Management">
      <Modal
        open={modal} onClose={() => setModal(false)}
        title={editing ? 'Edit Article' : 'New Article'}
        footer={<><Button variant="secondary" onClick={() => setModal(false)}>Cancel</Button><Button onClick={save} loading={saving}>Save</Button></>}
      >
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <Input label="Title *" value={form.title} onChange={e => setForm(f => ({ ...f, title:e.target.value }))} />
        <Input label="Summary" value={form.summary} onChange={e => setForm(f => ({ ...f, summary:e.target.value }))} />
        <Input label="Thumbnail URL" type="url" value={form.thumbnail} onChange={e => setForm(f => ({ ...f, thumbnail:e.target.value }))} />
        <div className="field">
          <label>Content</label>
          <textarea className="input" rows={5} value={form.content} onChange={e => setForm(f => ({ ...f, content:e.target.value }))} style={{ resize:'vertical' }} />
        </div>
        <div style={{ display:'flex', gap:20, marginTop:8 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer' }}>
            <input type="checkbox" checked={form.is_published} onChange={e => setForm(f => ({ ...f, is_published:e.target.checked }))} />
            Published
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer' }}>
            <input type="checkbox" checked={form.is_featured} onChange={e => setForm(f => ({ ...f, is_featured:e.target.checked }))} />
            Featured
          </label>
        </div>
      </Modal>

      <div className="page">
        <div className="page__header">
          <div><h1>News Management</h1><p>{articles.length} articles</p></div>
          <Button onClick={openCreate}><Plus size={14} /> New Article</Button>
        </div>
        <Card flush>
          {loading ? <Loading /> : articles.length === 0 ? (
            <Empty icon={Newspaper} title="No articles" description="Create your first article." action={<Button onClick={openCreate}><Plus size={14} />New Article</Button>} />
          ) : (
            <table className="table">
              <thead><tr><th>Title</th><th>Status</th><th>Featured</th><th>Published</th><th>Actions</th></tr></thead>
              <tbody>
                {articles.map(a => (
                  <tr key={a.id}>
                    <td style={{ maxWidth:280 }}><strong style={{ display:'block', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.title}</strong></td>
                    <td><Badge variant={a.is_published ? 'green' : 'gray'}>{a.is_published ? 'Published' : 'Draft'}</Badge></td>
                    <td><Badge variant={a.is_featured ? 'orange' : 'gray'}>{a.is_featured ? 'Yes' : 'No'}</Badge></td>
                    <td style={{ fontSize:12, color:'#64748B' }}>{fmt.date(a.published_at)}</td>
                    <td>
                      <div style={{ display:'flex', gap:6 }}>
                        <button className="btn btn--ghost btn--sm" onClick={() => openEdit(a)}><Edit2 size={13} /></button>
                        <button className="btn btn--ghost btn--sm" style={{ color:'#EF4444' }} onClick={() => del(a.id)}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
