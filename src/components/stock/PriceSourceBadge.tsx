// ════════════════════════════════════════════════════════════════
//  PriceSourceBadge — visual indicator of which upstream served
//  the current price. Signal-only mode serves Yahoo or nothing.
// ════════════════════════════════════════════════════════════════

import React from 'react';

export type PriceSource = 'yahoo' | 'none';

const CONFIG: Record<PriceSource, { label: string; dot: string; cls: string }> = {
  yahoo: { label: 'Yahoo (Delayed)', dot: '🟡', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  none:  { label: 'No Data',         dot: '⚠',  cls: 'bg-gray-50   text-gray-600   border-gray-200'   },
};

export function PriceSourceBadge({ source }: { source: string | undefined }) {
  const key: PriceSource = source === 'yahoo' ? 'yahoo' : 'none';
  const cfg = CONFIG[key];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${cfg.cls}`}
      title={`Price source: ${cfg.label}`}
    >
      <span aria-hidden>{cfg.dot}</span>
      {cfg.label}
    </span>
  );
}

export default PriceSourceBadge;
