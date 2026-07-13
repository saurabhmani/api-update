'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui';
import { MANAGEABLE_STRATEGY_MODES, strategyModeLabel } from '@/lib/strategy-hub/strategyModeDisplay';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import type { StrategyHubSummary } from '@/lib/strategy-hub/types';
import styles from '@/app/strategies/strategies.module.scss';

type BulkAction =
  | { kind: 'mode'; mode: StrategyMode }
  | { kind: 'category'; mode: StrategyMode; category: string }
  | { kind: 'regime'; mode: StrategyMode; regime: string }
  | { kind: 'type'; mode: StrategyMode; strategyType: string };

interface Props {
  strategies: StrategyHubSummary[];
  selectedIds: Set<string>;
  onSelectAll: () => void;
  onClearSelection: () => void;
  categories: Array<{ id: string; label: string }>;
}

export function BulkActionToolbar({
  strategies,
  selectedIds,
  onSelectAll,
  onClearSelection,
  categories,
}: Props) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<BulkAction | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [categoryPick, setCategoryPick] = useState(categories[0]?.id ?? '');
  const [regimePick, setRegimePick] = useState('Bullish');
  const [typePick, setTypePick] = useState('entry');

  const selectedCount = selectedIds.size;
  const selectedLabel = useMemo(() => {
    if (!pending) return '';
    if (pending.kind === 'mode') return `${selectedCount} selected strategies`;
    if (pending.kind === 'category') return `all strategies in category “${pending.category}”`;
    if (pending.kind === 'regime') return `strategies allowed in regime “${pending.regime}”`;
    return `strategies of type “${pending.strategyType}”`;
  }, [pending, selectedCount]);

  const runBulk = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        mode: pending.mode,
        reason: reason.trim() || null,
      };
      if (pending.kind === 'mode') {
        if (selectedCount === 0) throw new Error('Select at least one strategy');
        payload.strategyIds = [...selectedIds];
      } else if (pending.kind === 'category') {
        payload.category = pending.category;
      } else if (pending.kind === 'regime') {
        payload.regime = pending.regime;
      } else {
        payload.strategyType = pending.strategyType;
      }

      const res = await fetch('/api/strategies/management/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Bulk update failed');
      }
      setMessage(body.message ?? 'Bulk update complete');
      setPending(null);
      onClearSelection();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-hub'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-management'] }),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.bulkToolbar}>
      <div className={styles.bulkToolbarRow}>
        <span className={styles.bulkCount}>
          {selectedCount} selected
          <span style={{ color: '#94A3B8', marginLeft: 6 }}>/ {strategies.length} visible</span>
        </span>
        <button type="button" className={styles.filterChip} onClick={onSelectAll}>
          Select All Visible
        </button>
        <button type="button" className={styles.filterChip} onClick={onClearSelection}>
          Deselect
        </button>
      </div>

      <div className={styles.bulkToolbarRow}>
        <span className={styles.filterLabel}>Bulk</span>
        {MANAGEABLE_STRATEGY_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={styles.filterChip}
            disabled={selectedCount === 0 || busy}
            onClick={() => {
              setPending({ kind: 'mode', mode });
              setReason('');
              setError(null);
            }}
          >
            {mode === 'CONFIRMED_ENABLED' ? 'Enable' : mode === 'DISABLED' ? 'Disable' : 'Watchlist'}
          </button>
        ))}
      </div>

      <div className={styles.bulkToolbarRow}>
        <span className={styles.filterLabel}>By Category</span>
        <select
          className="input"
          style={{ width: 160, padding: '4px 8px' }}
          value={categoryPick}
          onChange={(e) => setCategoryPick(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.filterChip}
          disabled={!categoryPick || busy}
          onClick={() => {
            setPending({ kind: 'category', mode: 'CONFIRMED_ENABLED', category: categoryPick });
            setReason('');
            setError(null);
          }}
        >
          Activate Category
        </button>
      </div>

      <div className={styles.bulkToolbarRow}>
        <span className={styles.filterLabel}>By Regime</span>
        <select
          className="input"
          style={{ width: 160, padding: '4px 8px' }}
          value={regimePick}
          onChange={(e) => setRegimePick(e.target.value)}
        >
          {['Strong Bullish', 'Bullish', 'Sideways', 'Weak', 'Bearish', 'High Volatility Risk'].map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.filterChip}
          disabled={busy}
          onClick={() => {
            setPending({ kind: 'regime', mode: 'CONFIRMED_ENABLED', regime: regimePick });
            setReason('');
            setError(null);
          }}
        >
          Activate Regime
        </button>

        <span className={styles.filterLabel}>By Type</span>
        <select
          className="input"
          style={{ width: 120, padding: '4px 8px' }}
          value={typePick}
          onChange={(e) => setTypePick(e.target.value)}
        >
          <option value="entry">Entry</option>
          <option value="confirmation">Confirmation</option>
        </select>
        <button
          type="button"
          className={styles.filterChip}
          disabled={busy}
          onClick={() => {
            setPending({ kind: 'type', mode: 'CONFIRMED_ENABLED', strategyType: typePick });
            setReason('');
            setError(null);
          }}
        >
          Activate Type
        </button>
      </div>

      {message && <div className={styles.cardMessage}>{message}</div>}

      <Modal
        open={pending != null}
        onClose={() => !busy && setPending(null)}
        title="Confirm bulk mode change"
        footer={
          <>
            <button type="button" className="btn btn--outline btn--sm" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={runBulk}>
              {busy ? 'Applying…' : `Apply ${pending ? strategyModeLabel(pending.mode) : ''}`}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          Set mode to <strong>{pending ? strategyModeLabel(pending.mode) : ''}</strong> for{' '}
          <strong>{selectedLabel}</strong>?
        </p>
        <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}>
          Reason (optional)
        </label>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Bulk enable momentum strategies"
          disabled={busy}
        />
        {error && <p style={{ color: '#DC2626', fontSize: '0.85rem' }}>{error}</p>}
      </Modal>
    </div>
  );
}
