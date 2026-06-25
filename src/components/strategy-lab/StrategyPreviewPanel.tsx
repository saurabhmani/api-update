'use client';

import { Eye } from 'lucide-react';
import { Card } from '@/components/ui';
import type { StrategyPreviewResult } from '@/lib/strategy-lab/types';
import styles from '@/app/strategies/lab/lab.module.scss';

interface Props {
  preview: StrategyPreviewResult | null;
  dsl?: string;
  json?: string;
}

export function StrategyPreviewPanel({ preview, dsl, json }: Props) {
  if (!preview && !dsl && !json) return null;

  return (
    <>
      {preview && (
        <Card compact>
          <h3 className={styles.panelTitle}><Eye size={16} /> Strategy Preview</h3>
          <div className={styles.previewBlock}>
            <p>{preview.summary}</p>
            <h4>Entry</h4>
            <p>{preview.entryDescription}</p>
            <h4>Exit</h4>
            <p>{preview.exitDescription}</p>
            <h4>Stop Loss</h4>
            <p>{preview.stopLossDescription}</p>
            <h4>Targets</h4>
            <p>{preview.targetDescriptions.join(', ')}</p>
            <h4>Risk</h4>
            <p>{preview.riskDescription}</p>
            <h4>Signal Frequency</h4>
            <p>{preview.estimatedSignalsPerMonth}</p>
            {preview.warnings.map((w) => (
              <p key={w} style={{ color: '#D97706' }}>{w}</p>
            ))}
          </div>
        </Card>
      )}

      {(dsl || json) && (
        <Card compact>
          {dsl && (
            <>
              <h3 className={styles.panelTitle}>Strategy DSL</h3>
              <pre className={styles.codeBlock}>{dsl}</pre>
            </>
          )}
          {json && (
            <>
              <h3 className={styles.panelTitle} style={{ marginTop: dsl ? 12 : 0 }}>Structured JSON</h3>
              <pre className={styles.codeBlock}>{json}</pre>
            </>
          )}
        </Card>
      )}
    </>
  );
}
