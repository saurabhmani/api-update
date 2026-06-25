'use client';

import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui';
import type { ValidationResult } from '@/lib/strategy-lab/types';
import styles from '@/app/strategies/lab/lab.module.scss';

interface Props {
  validation: ValidationResult | null;
}

export function ValidationPanel({ validation }: Props) {
  if (!validation) return null;

  return (
    <Card compact>
      <h3 className={styles.panelTitle}>
        <CheckCircle2 size={16} color={validation.valid ? '#16A34A' : '#DC2626'} />
        Validation Panel — {validation.valid ? 'Passed' : 'Failed'}
      </h3>
      <ul className={styles.issueList}>
        {validation.issues.length === 0 && (
          <li style={{ fontSize: '0.82rem', color: '#16A34A' }}>All checks passed</li>
        )}
        {validation.issues.map((issue) => (
          <li key={`${issue.code}-${issue.message}`} className={issue.severity === 'error' ? styles.issueError : styles.issueWarning}>
            {issue.message}
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 10, fontSize: '0.75rem', color: '#64748B', display: 'flex', gap: 12 }}>
        <span>Save: {validation.canSave ? '✓' : '✗'}</span>
        <span>Backtest: {validation.canBacktest ? '✓' : '✗'}</span>
        <span>Deploy: {validation.canDeploy ? '✓' : '✗'}</span>
      </div>
    </Card>
  );
}
