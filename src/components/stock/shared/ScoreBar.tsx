'use client';

import s from '../StockDashboard.module.scss';
import { clsx } from '@/lib/utils';

interface Props {
  value: number;
  max?: number;
  variant?: 'default' | 'success' | 'warning' | 'danger';
  width?: number;
}

export default function ScoreBar({
  value,
  max = 100,
  variant,
  width,
}: Props) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const auto = pct >= 65 ? 'success' : pct >= 40 ? 'warning' : 'danger';
  const v = variant ?? auto;

  return (
    <span className={s.scoreBar} style={width ? { width } : undefined}>
      <span
        className={clsx(s.scoreBarFill, s[`scoreBarFill--${v}`])}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
