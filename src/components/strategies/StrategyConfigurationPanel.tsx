'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Loading, Modal } from '@/components/ui';
import {
  useStrategyConfigHistory,
  useStrategyConfiguration,
  type StrategyConfigPreviewResult,
} from '@/hooks/useStrategyConfiguration';
import {
  MARKET_REGIME_LABELS,
  RISK_PROFILES,
  TIMEFRAMES,
} from '@/lib/strategy-hub/strategyParameterCatalog';
import type { StrategyConfigFieldView } from '@/lib/strategy-hub/types';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  strategyId: string;
  canManage: boolean;
}

type Tab = 'config' | 'history';

function fmtVal(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function FieldEditor({
  field,
  draft,
  onChange,
  disabled,
}: {
  field: StrategyConfigFieldView;
  draft: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const value = draft ?? field.effectiveValue;

  if (field.type === 'rsiRange') {
    const range = Array.isArray(value) ? value : field.effectiveValue;
    const [lo, hi] = Array.isArray(range) ? range : [30, 70];
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={lo}
          disabled={disabled}
          style={{ width: 72 }}
          onChange={(e) => onChange([Number(e.target.value), hi])}
        />
        <span>to</span>
        <input
          className="input"
          type="number"
          min={0}
          max={100}
          value={hi}
          disabled={disabled}
          style={{ width: 72 }}
          onChange={(e) => onChange([lo, Number(e.target.value)])}
        />
      </div>
    );
  }

  if (field.type === 'regimeList') {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className={styles.regimePickers}>
        {MARKET_REGIME_LABELS.map((r) => (
          <label key={r} className={styles.regimeCheck}>
            <input
              type="checkbox"
              checked={selected.has(r)}
              disabled={disabled}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(r);
                else next.delete(r);
                onChange([...next]);
              }}
            />
            <span>{r}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === 'riskProfile') {
    return (
      <select
        className="input"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {RISK_PROFILES.map((r) => (
          <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
        ))}
      </select>
    );
  }

  if (field.type === 'timeframe') {
    return (
      <select
        className="input"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {TIMEFRAMES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="input"
      type="number"
      step={field.type === 'weight' ? 0.05 : 0.5}
      value={value == null ? '' : Number(value)}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function StrategyConfigurationPanel({ strategyId, canManage }: Props) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useStrategyConfiguration(strategyId);
  const { data: history, isLoading: historyLoading } = useStrategyConfigHistory(strategyId);
  const [tab, setTab] = useState<Tab>('config');
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<StrategyConfigPreviewResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const config = data?.config;

  useEffect(() => {
    if (!config) return;
    const initial: Record<string, unknown> = {};
    for (const field of config.fields) {
      initial[field.key] = field.effectiveValue;
    }
    setDraft(initial);
  }, [config]);

  const changedKeys = useMemo(() => {
    if (!config) return [];
    return config.fields
      .filter((f) => JSON.stringify(draft[f.key]) !== JSON.stringify(f.effectiveValue))
      .map((f) => f.key);
  }, [config, draft]);

  const patch = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key of changedKeys) {
      out[key] = draft[key];
    }
    return out;
  }, [changedKeys, draft]);

  const runPreview = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/strategies/${strategyId}/config/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ values: patch }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Preview failed');
      setPreview(body.preview as StrategyConfigPreviewResult);
      setShowPreview(true);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const applySave = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/strategies/${strategyId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ values: patch, reason: reason.trim() || null }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? body.preview?.issues?.[0]?.message ?? 'Save failed');
      }
      setMessage(body.message ?? 'Configuration saved');
      setShowPreview(false);
      setReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-config', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-config-history', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-hub'] }),
      ]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const resetParam = async (key?: string) => {
    if (!canManage) return;
    if (!key && !window.confirm('Reset all parameters to registry defaults?')) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const qs = key ? `?key=${encodeURIComponent(key)}` : '';
      const res = await fetch(`/api/strategies/${strategyId}/config${qs}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Reset failed');
      setMessage(body.message ?? 'Reset complete');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-config', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-config-history', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail', strategyId] }),
      ]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (versionId: number) => {
    if (!window.confirm('Restore this configuration version?')) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/strategies/${strategyId}/config/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ versionId, reason: 'Restored from history' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? 'Restore failed');
      setMessage(body.message ?? 'Version restored');
      setTab('config');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-config', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-config-history', strategyId] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail', strategyId] }),
      ]);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return <Card title="Strategy Configuration"><Loading text="Loading configuration…" /></Card>;
  }

  if (error || !config) {
    return (
      <Card title="Strategy Configuration">
        <p style={{ margin: 0, color: '#DC2626' }}>Could not load strategy configuration.</p>
      </Card>
    );
  }

  return (
    <Card
      title="Strategy Configuration"
      action={
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className={tab === 'config' ? styles.filterChipActive : styles.filterChip}
            onClick={() => setTab('config')}
          >
            Parameters
          </button>
          <button
            type="button"
            className={tab === 'history' ? styles.filterChipActive : styles.filterChip}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>
      }
    >
      {tab === 'config' && (
        <>
          <p style={{ margin: '0 0 12px', fontSize: '0.85rem', color: '#64748B' }}>
            Version {config.version}
            {config.lastUpdated && <> · Updated {fmtWhen(config.lastUpdated)}</>}
            {config.lastUpdatedBy && <> by {config.lastUpdatedBy}</>}
          </p>

          <div className={styles.configFields}>
            {config.fields.map((field) => (
              <div key={field.key} className={styles.configField}>
                <div className={styles.configFieldHeader}>
                  <div>
                    <div className={styles.configFieldLabel}>
                      {field.label}
                      {field.isOverridden && <span className={styles.overrideTag}>Overridden</span>}
                    </div>
                    <div className={styles.configFieldDesc}>{field.description}</div>
                  </div>
                  {canManage && field.isOverridden && (
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      disabled={busy}
                      onClick={() => resetParam(field.key)}
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div className={styles.configCompare}>
                  <div>
                    <div className={styles.configMetaLabel}>Registry Default</div>
                    <div>{fmtVal(field.registryDefault)}</div>
                  </div>
                  <div>
                    <div className={styles.configMetaLabel}>Effective</div>
                    <div style={{ fontWeight: 600 }}>{fmtVal(field.effectiveValue)}</div>
                  </div>
                </div>
                {canManage && (
                  <div>
                    <div className={styles.configMetaLabel}>Override</div>
                    <FieldEditor
                      field={field}
                      draft={draft[field.key]}
                      disabled={busy}
                      onChange={(v) => setDraft((prev) => ({ ...prev, [field.key]: v }))}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {canManage && (
            <div className={styles.configActions}>
              <input
                className="input"
                placeholder="Reason for change (optional)"
                value={reason}
                disabled={busy}
                onChange={(e) => setReason(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  disabled={busy || changedKeys.length === 0}
                  onClick={runPreview}
                >
                  Preview Changes
                </button>
                <button
                  type="button"
                  className="btn btn--outline btn--sm"
                  disabled={busy}
                  onClick={() => resetParam()}
                >
                  Reset All
                </button>
              </div>
            </div>
          )}

          {!canManage && (
            <p style={{ margin: '12px 0 0', fontSize: '0.85rem', color: '#64748B' }}>
              Configuration is read-only. Administrators can modify parameters.
            </p>
          )}
        </>
      )}

      {tab === 'history' && (
        <>
          {historyLoading && <Loading text="Loading history…" />}
          {!historyLoading && (!history || history.length === 0) && (
            <p style={{ margin: 0, color: '#64748B' }}>No configuration changes recorded.</p>
          )}
          {!historyLoading && history && history.length > 0 && (
            <ul className={styles.auditList}>
              {history.map((row) => (
                <li key={row.id} className={styles.auditItem}>
                  <div className={styles.auditItemHeader}>
                    <strong>v{row.version_number}</strong>
                    <span className={styles.auditEvent}>{row.source}</span>
                  </div>
                  <div className={styles.auditMeta}>
                    {fmtWhen(row.created_at)}
                    {row.actor && <> · {row.actor}</>}
                  </div>
                  <div style={{ fontSize: '0.82rem', marginTop: 4 }}>{row.change_summary}</div>
                  {row.reason && (
                    <div style={{ fontSize: '0.78rem', color: '#64748B', marginTop: 2 }}>
                      Reason: {row.reason}
                    </div>
                  )}
                  {canManage && row.source !== 'reset' && (
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      style={{ marginTop: 8 }}
                      disabled={busy}
                      onClick={() => restoreVersion(row.id)}
                    >
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {message && <div className={styles.cardMessage} style={{ marginTop: 12 }}>{message}</div>}
      {errorMsg && (
        <div className={styles.cardMessage} style={{ marginTop: 12, color: '#DC2626' }}>
          {errorMsg}
        </div>
      )}

      <Modal
        open={showPreview}
        onClose={() => !busy && setShowPreview(false)}
        title="Preview Configuration Changes"
        wide
        footer={
          <>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={busy}
              onClick={() => setShowPreview(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy || !preview?.valid || (preview?.changes.length ?? 0) === 0}
              onClick={applySave}
            >
              {busy ? 'Saving…' : 'Confirm & Save'}
            </button>
          </>
        }
      >
        {!preview && <Loading text="Building preview…" />}
        {preview && !preview.valid && (
          <div>
            <p style={{ color: '#DC2626' }}>Validation failed:</p>
            <ul>
              {preview.issues.map((i) => (
                <li key={i.key}>{i.message}</li>
              ))}
            </ul>
          </div>
        )}
        {preview?.valid && preview.changes.length === 0 && (
          <p>No changes detected.</p>
        )}
        {preview?.valid && preview.changes.length > 0 && (
          <>
            <p style={{ fontSize: '0.9rem' }}>{preview.summary}</p>
            <table className={styles.deploymentTable} style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Previous</th>
                  <th>New</th>
                  <th>Impact</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td>{fmtVal(c.previousValue)}</td>
                    <td><strong>{fmtVal(c.newValue)}</strong></td>
                    <td style={{ fontSize: '0.8rem', color: '#64748B' }}>{c.impact}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Modal>
    </Card>
  );
}
