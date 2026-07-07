'use client';

import { Eye } from 'lucide-react';
import { Card } from '@/components/ui';
import type { StrategyPreviewResult } from '@/lib/strategy-lab/types';
import styles from '@/app/strategies/lab/lab.module.scss';

interface Props {
  preview: StrategyPreviewResult | null;
  dsl?: string;
  json?: string;
  backtestConfig?: string;
}

export function StrategyPreviewPanel({ preview, dsl, json, backtestConfig }: Props) {
  if (!preview && !dsl && !json && !backtestConfig) return null;

  return (
    <>
      {preview && (
        <Card compact>
          <h3 className={styles.panelTitle}><Eye size={16} /> Strategy Preview</h3>
          <div className={styles.previewBlock}>
            <p className={styles.previewSummary}>{preview.summary}</p>
            <div className={styles.previewGrid}>
              <div className={styles.previewItem}>
                <h4>Entry Rules</h4>
                <p>{preview.entryDescription}</p>
              </div>
              <div className={styles.previewItem}>
                <h4>Exit Rules</h4>
                <p>{preview.exitDescription}</p>
              </div>
              <div className={styles.previewItem}>
                <h4>Stop Loss</h4>
                <p>{preview.stopLossDescription}</p>
              </div>
              <div className={styles.previewItem}>
                <h4>Targets</h4>
                <p>{preview.targetDescriptions.join(', ')}</p>
              </div>
              <div className={styles.previewItem}>
                <h4>Risk</h4>
                <p>{preview.riskDescription}</p>
              </div>
              <div className={styles.previewItem}>
                <h4>Signal Frequency</h4>
                <p>{preview.estimatedSignalsPerMonth}</p>
              </div>
            </div>
            {preview.warnings.map((w) => (
              <p key={w} className={styles.warningText}>{w}</p>
            ))}
          </div>
        </Card>
      )}

      {(dsl || json || backtestConfig) && (
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
          {backtestConfig && (
            <>
              <h3 className={styles.panelTitle} style={{ marginTop: dsl || json ? 12 : 0 }}>Backtest-Ready Configuration</h3>
              <pre className={styles.codeBlock}>{backtestConfig}</pre>
            </>
          )}
        </Card>
      )}
    </>
  );
}
