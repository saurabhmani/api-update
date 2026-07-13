'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui';
import { MANAGEABLE_STRATEGY_MODES, strategyModeLabel } from '@/lib/strategy-hub/strategyModeDisplay';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import styles from '@/app/strategies/strategies.module.scss';

interface Props {
  strategyId: string;
  currentMode: StrategyMode | string;
  disabled?: boolean;
  onChanged?: (mode: StrategyMode) => void;
}

export function StrategyModeControls({ strategyId, currentMode, disabled, onChanged }: Props) {
  const queryClient = useQueryClient();
  const [pendingMode, setPendingMode] = useState<StrategyMode | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const openConfirm = (mode: StrategyMode) => {
    if (mode === currentMode || busy || disabled) return;
    setPendingMode(mode);
    setReason('');
    setError(null);
  };

  const applyMode = async () => {
    if (!pendingMode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/strategies/management', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          strategyId,
          mode: pendingMode,
          reason: reason.trim() || null,
          source: 'ui',
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? 'Mode update failed');
      }
      setMessage(body.message ?? `Mode set to ${strategyModeLabel(pendingMode)}`);
      onChanged?.(pendingMode);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['strategy-hub'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-detail'] }),
        queryClient.invalidateQueries({ queryKey: ['strategy-management'] }),
      ]);
      setPendingMode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mode update failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.modeControls}>
      <div className={styles.modeControlButtons}>
        {MANAGEABLE_STRATEGY_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            className={
              currentMode === mode
                ? styles.modeBtnActive
                : styles.modeBtn
            }
            disabled={disabled || busy || currentMode === mode}
            onClick={() => openConfirm(mode)}
            title={`Set mode to ${strategyModeLabel(mode)}`}
          >
            {strategyModeLabel(mode)}
          </button>
        ))}
      </div>
      {message && <div className={styles.cardMessage}>{message}</div>}
      {error && !pendingMode && (
        <div className={styles.cardMessage} style={{ color: '#DC2626' }}>{error}</div>
      )}

      <Modal
        open={pendingMode != null}
        onClose={() => !busy && setPendingMode(null)}
        title="Confirm strategy mode change"
        footer={
          <>
            <button
              type="button"
              className="btn btn--outline btn--sm"
              disabled={busy}
              onClick={() => setPendingMode(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={busy}
              onClick={applyMode}
            >
              {busy ? 'Updating…' : `Set ${pendingMode ? strategyModeLabel(pendingMode) : ''}`}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>
          Change <strong>{strategyId}</strong> from{' '}
          <strong>{strategyModeLabel(currentMode)}</strong> to{' '}
          <strong>{pendingMode ? strategyModeLabel(pendingMode) : ''}</strong>?
        </p>
        <p style={{ fontSize: '0.85rem', color: '#64748B' }}>
          This updates Signal Engine participation immediately via runtime overrides.
        </p>
        <label style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}>
          Reason (optional)
        </label>
        <input
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Under review after drawdown"
          disabled={busy}
        />
        {error && <p style={{ color: '#DC2626', fontSize: '0.85rem' }}>{error}</p>}
      </Modal>
    </div>
  );
}
