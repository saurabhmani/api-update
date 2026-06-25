'use client';

import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Brain, FlaskConical, Rocket, Save, ShieldCheck, Sparkles,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Button, Card } from '@/components/ui';
import { NoCodeBuilder } from '@/components/strategy-lab/NoCodeBuilder';
import { ValidationPanel } from '@/components/strategy-lab/ValidationPanel';
import { StrategyPreviewPanel } from '@/components/strategy-lab/StrategyPreviewPanel';
import type {
  StrategyDefinition,
  StrategyLabRecord,
  StrategyPreviewResult,
  ValidationResult,
} from '@/lib/strategy-lab/types';
import styles from '@/app/strategies/lab/lab.module.scss';

const DEFAULT_DEFINITION: StrategyDefinition = {
  name: 'My Strategy',
  timeframe: 'swing',
  direction: 'long',
  source: 'no_code',
  entry: {
    operator: 'AND',
    conditions: [{ id: uuidv4().slice(0, 8), indicator: 'rsi', operator: 'between', value: [45, 65] }],
  },
  exit: {
    operator: 'OR',
    conditions: [{ id: uuidv4().slice(0, 8), indicator: 'rsi', operator: 'gt', value: 75 }],
  },
  stopLoss: { type: 'percent', value: 2 },
  targets: [{ type: 'rr_multiple', value: 2, label: 'T1' }],
  risk: { riskPerTradePct: 0.5, maxOpenPositions: 5, maxGrossExposurePct: 40, minRewardRisk: 1.5 },
};

type Tab = 'rule' | 'ai';

export default function StrategyLabPage() {
  const [tab, setTab] = useState<Tab>('rule');
  const [definition, setDefinition] = useState<StrategyDefinition>(DEFAULT_DEFINITION);
  const [aiText, setAiText] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [preview, setPreview] = useState<StrategyPreviewResult | null>(null);
  const [dsl, setDsl] = useState('');
  const [json, setJson] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [backtestId, setBacktestId] = useState<string | null>(null);
  const [backtestPassed, setBacktestPassed] = useState(false);
  const [deployed, setDeployed] = useState(false);
  const [savedList, setSavedList] = useState<StrategyLabRecord[]>([]);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');

  const pipeline = [
    { key: 'build', label: 'Build', done: true },
    { key: 'validate', label: 'Validate', done: !!validation?.valid },
    { key: 'save', label: 'Save', done: !!savedId },
    { key: 'backtest', label: 'Backtest', done: backtestPassed },
    { key: 'deploy', label: 'Paper Deploy', done: deployed },
  ];

  const loadSaved = useCallback(async () => {
    const res = await fetch('/api/strategies/lab');
    const data = await res.json();
    if (data.ok) setSavedList(data.strategies ?? []);
  }, []);

  const parseAi = async () => {
    setLoading('parse');
    setError('');
    try {
      const res = await fetch('/api/strategy-builder/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: aiText, name: definition.name || 'AI Strategy' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setDefinition(data.definition);
      setJson(JSON.stringify(data.json, null, 2));
      setDsl(data.dsl ?? '');
      setValidation(null);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed');
    } finally {
      setLoading('');
    }
  };

  const runValidate = async () => {
    setLoading('validate');
    setError('');
    try {
      const res = await fetch('/api/strategy-builder/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition, backtestPassed, strategyId: savedId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setValidation(data.validation);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation failed');
    } finally {
      setLoading('');
    }
  };

  const runPreview = async () => {
    setLoading('preview');
    setError('');
    try {
      const res = await fetch('/api/strategies/lab/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ definition }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setPreview(data.preview);
      setDsl(data.dsl);
      setJson(data.json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading('');
    }
  };

  const runSave = async () => {
    setLoading('save');
    setError('');
    try {
      const res = await fetch('/api/strategy-builder/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...definition, source: tab === 'ai' ? 'ai' : 'no_code' },
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setSavedId(data.strategyId);
      setValidation(data.validation);
      setDsl(data.dsl);
      setJson(JSON.stringify(data.json, null, 2));
      await loadSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setLoading('');
    }
  };

  const runBacktest = async () => {
    if (!savedId) { setError('Save strategy before backtest'); return; }
    setLoading('backtest');
    setError('');
    try {
      const res = await fetch('/api/strategy-builder/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategyId: savedId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setBacktestId(data.backtestId);
      setBacktestPassed(data.backtestPassed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest failed');
    } finally {
      setLoading('');
    }
  };

  const runDeploy = async () => {
    if (!savedId) { setError('Save strategy before deploy'); return; }
    setLoading('deploy');
    setError('');
    try {
      const res = await fetch(`/api/strategies/lab/${savedId}/deploy`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.issues?.join('; ') ?? data.error);
      setDeployed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setLoading('');
    }
  };

  const loadStrategy = async (id: string) => {
    const res = await fetch(`/api/strategies/lab/${id}`);
    const data = await res.json();
    if (data.ok && data.strategy) {
      setDefinition(data.strategy.definition);
      setSavedId(data.strategy.id);
      setValidation(data.strategy.validation);
      setBacktestPassed(data.strategy.backtestPassed);
      setDeployed(data.strategy.paperDeployed);
      setBacktestId(data.strategy.lastBacktestId);
      setTab(data.strategy.source === 'ai' ? 'ai' : 'rule');
    }
  };

  return (
    <AppShell title="Strategy Lab">
      <div className="page">
        <div className="page__header">
          <h1>Strategy Lab</h1>
          <p>Rule Builder and AI Builder — validate, preview, save, backtest, and deploy to paper trading.</p>
        </div>

        <div className={styles.pipeline}>
          {pipeline.map((step, i) => (
            <span
              key={step.key}
              className={step.done ? styles.pipelineStepDone : i === pipeline.findIndex((s) => !s.done) ? styles.pipelineStepActive : styles.pipelineStep}
            >
              {step.label}
            </span>
          ))}
        </div>

        <div className={styles.tabs}>
          <button type="button" className={tab === 'rule' ? styles.tabActive : styles.tab} onClick={() => setTab('rule')}>
            Rule Builder
          </button>
          <button type="button" className={tab === 'ai' ? styles.tabActive : styles.tab} onClick={() => setTab('ai')}>
            <Brain size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            AI Builder
          </button>
        </div>

        <div className={styles.layout}>
          <div>
            {tab === 'rule' ? (
              <NoCodeBuilder definition={definition} onChange={setDefinition} />
            ) : (
              <div className={styles.panel}>
                <h3 className={styles.panelTitle}><Sparkles size={16} /> AI Builder</h3>
                <p style={{ fontSize: '0.82rem', color: '#64748B', marginBottom: 12 }}>
                  Converts natural language into editable strategy rules and structured JSON.
                </p>
                <textarea
                  className={styles.aiTextarea}
                  value={aiText}
                  onChange={(e) => setAiText(e.target.value)}
                  placeholder="Example: Long swing strategy when RSI is between 45 and 65, ADX above 20, volume expansion 1.5x, stop loss 2%, target 2R..."
                />
                <div className={styles.actions}>
                  <Button onClick={parseAi} disabled={!aiText.trim() || loading === 'parse'}>
                    Generate Rules
                  </Button>
                </div>
                {(definition.source === 'ai' || json) && (
                  <div style={{ marginTop: 16 }}>
                    <NoCodeBuilder definition={definition} onChange={setDefinition} />
                  </div>
                )}
              </div>
            )}

            <div className={styles.actions}>
              <Button variant="secondary" onClick={runValidate} disabled={!!loading}>
                <ShieldCheck size={14} /> Validate
              </Button>
              <Button variant="secondary" onClick={runPreview} disabled={!!loading}>
                Preview
              </Button>
              <Button onClick={runSave} disabled={!!loading || (validation !== null && !validation.valid)}>
                <Save size={14} /> Save
              </Button>
              <Button variant="secondary" onClick={runBacktest} disabled={!!loading || !savedId}>
                <FlaskConical size={14} /> Backtest
              </Button>
              <Button onClick={runDeploy} disabled={!!loading || !backtestPassed}>
                <Rocket size={14} /> Paper Deploy
              </Button>
            </div>

            {error && <p style={{ color: '#DC2626', fontSize: '0.85rem' }}>{error}</p>}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <ValidationPanel validation={validation} />
            <StrategyPreviewPanel preview={preview} dsl={dsl} json={json} />

            <Card compact>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 className={styles.panelTitle} style={{ margin: 0 }}>Saved Strategies</h3>
                <Button variant="secondary" onClick={loadSaved}>Refresh</Button>
              </div>
              <div className={styles.savedList}>
                {savedList.length === 0 && <p style={{ fontSize: '0.82rem', color: '#94A3B8' }}>No saved strategies yet</p>}
                {savedList.map((s) => (
                  <button key={s.id} type="button" className={styles.savedItem} onClick={() => loadStrategy(s.id)}>
                    <strong>{s.name}</strong>
                    <span className={s.status === 'paper_ready' ? styles.badgePaper : s.backtestPassed ? styles.badgeBacktested : s.validated ? styles.badgeValidated : styles.badgeDraft} style={{ marginLeft: 8 }}>
                      {s.status}
                    </span>
                  </button>
                ))}
              </div>
              {savedId && <p style={{ fontSize: '0.75rem', color: '#64748B', marginTop: 8 }}>Current: {savedId}{backtestId ? ` · BT ${backtestId}` : ''}</p>}
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
