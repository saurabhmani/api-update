'use client';

import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
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
          <li className={styles.issueSuccess}>
            <CheckCircle2 size={15} />
            All validator checks passed.
          </li>
        )}
        {validation.issues.map((issue) => (
          <li key={`${issue.code}-${issue.message}`} className={issue.severity === 'error' ? styles.issueError : styles.issueWarning}>
            {issue.severity === 'error' ? <XCircle size={15} /> : <AlertTriangle size={15} />}
            {issue.message}
          </li>
        ))}
      </ul>
      <div className={styles.validationGates}>
        <span className={validation.canSave ? styles.gatePass : styles.gateFail}>Save {validation.canSave ? 'Ready' : 'Blocked'}</span>
        <span className={validation.canBacktest ? styles.gatePass : styles.gateFail}>Backtest {validation.canBacktest ? 'Ready' : 'Blocked'}</span>
        <span className={validation.canDeploy ? styles.gatePass : styles.gateFail}>Deploy {validation.canDeploy ? 'Ready' : 'Blocked'}</span>
      </div>
    </Card>
  );
}
