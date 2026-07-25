// Shared APPROVED-tab filter — must match what /signals renders in the table.

export function getDisplayableApprovedVetoReasons(
  row: Record<string, unknown>,
  signalQuality?: string | null,
  opts?: { allowHistorical?: boolean },
): string[] {
  const reasons: string[] = [];
  // Off-hours / historical fallback: relaxed + conditional rows are the
  // best available setup — do not elite-veto them off the main table.
  if (!opts?.allowHistorical) {
    if (row.is_relaxed === true) reasons.push('is_relaxed');
    if (row.is_conditional === true) reasons.push('is_conditional');
    const sq = String(signalQuality ?? '').toUpperCase();
    if (sq === 'RELAXED' || sq === 'SCANNER_CANDIDATES') {
      reasons.push('signal_quality_relaxed');
    }
  }
  if (row.is_scanner_candidate === true && !opts?.allowHistorical) {
    reasons.push('scanner_candidate');
  }
  if (row.execution_allowed === false) reasons.push('execution_allowed=false');
  if (row.live_invalidated === true) reasons.push('live_invalidated=true');
  if (row.invalidation_reason) reasons.push(`invalidated:${String(row.invalidation_reason)}`);
  const tradeability = String(row.tradeability_status ?? '').toLowerCase();
  if (tradeability === 'blocked' || tradeability === 'restricted') {
    reasons.push(`tradeability=${tradeability}`);
  }
  const conv = String(row.conviction_band ?? '').toLowerCase();
  if (conv === 'avoid') reasons.push('conviction_band=avoid');
  return reasons;
}

export function isDisplayableApproved(
  row: Record<string, unknown>,
  signalQuality?: string | null,
  opts?: { allowHistorical?: boolean },
): boolean {
  return getDisplayableApprovedVetoReasons(row, signalQuality, opts).length === 0;
}

export function filterDisplayableApproved<T extends Record<string, unknown>>(
  rows: readonly T[],
  signalQuality?: string | null,
  opts?: { allowHistorical?: boolean },
): T[] {
  return rows.filter((r) => isDisplayableApproved(r, signalQuality, opts));
}

export function countDisplayableApproved(
  rows: readonly Record<string, unknown>[],
  signalQuality?: string | null,
  opts?: { allowHistorical?: boolean },
): number {
  return filterDisplayableApproved(rows, signalQuality, opts).length;
}
