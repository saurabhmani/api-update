// ════════════════════════════════════════════════════════════════
//  PriceSourceBadge — visual indicator of which upstream served
//  the current price. Frontend only ever sees Kite / Yahoo / none.
//
//    🟢 Kite (Live)
//    🟡 Yahoo (Delayed)
//    ⚠  No Data
// ════════════════════════════════════════════════════════════════

import React from 'react';

export type PriceSource = 'kite' | 'yahoo' | 'none';

const CONFIG: Record<PriceSource, { label: string; dot: string; cls: string }> = {
  kite:  { label: 'Kite (Live)',     dot: '🟢', cls: 'bg-green-50  text-green-700  border-green-200'  },
  yahoo: { label: 'Yahoo (Delayed)', dot: '🟡', cls: 'bg-yellow-50 text-yellow-700 border-yellow-200' },
  none:  { label: 'No Data',         dot: '⚠',  cls: 'bg-gray-50   text-gray-600   border-gray-200'   },
};

export function PriceSourceBadge({ source }: { source: string | undefined }) {
  const key: PriceSource =
    source === 'kite' || source === 'yahoo' ? source : 'none';
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
