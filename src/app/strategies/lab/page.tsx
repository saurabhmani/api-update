'use client';

import { useCallback, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  Brain, CheckCircle2, FlaskConical, Rocket, Save, ShieldCheck, Sparkles,
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
  market: 'equity',
  symbolUniverse: ['NIFTY 500'],
  timeframe: 'swing',
  direction: 'long',
  marketRegimeFilter: ['Bullish'],
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

const SAMPLE_PROMPTS = [
  'Create a bullish Fibonacci pullback strategy for NIFTY 500 with 2% stop loss, 2R target, and 0.5% risk per trade.',
  'Create a momentum continuation strategy when RSI is above 55, ADX above 20, and volume expands 1.5x.',
  'Create a short bearish breakdown strategy with 3% stop loss and 2R target.',
];

export default function StrategyLabPage() {
  const [tab, setTab] = useState<Tab>('rule');
  const [definition, setDefinition] = useState<StrategyDefinition>(DEFAULT_DEFINITION);
  const [aiText, setAiText] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [preview, setPreview] = useState<StrategyPreviewResult | null>(null);
  const [dsl, setDsl] = useState('');
  const [json, setJson] = useState('');
  const [backtestConfigJson, setBacktestConfigJson] = useState('');
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
  const activeStepIndex = pipeline.findIndex((s) => !s.done);
  const currentStep = activeStepIndex === -1 ? pipeline.length : activeStepIndex + 1;

  const updateDefinition = useCallback((next: StrategyDefinition) => {
    setDefinition(next);
    setValidation(null);
    setPreview(null);
    setDsl('');
    setJson('');
    setBacktestConfigJson('');
    setBacktestId(null);
    setBacktestPassed(false);
    setDeployed(false);
  }, []);

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
      setBacktestConfigJson(JSON.stringify(data.backtestConfig ?? {}, null, 2));
      const [validationRes, previewRes] = await Promise.all([
        fetch('/api/strategies/lab/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: data.definition, backtestPassed, strategyId: savedId }),
        }).then((r) => r.json()),
        fetch('/api/strategies/lab/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: data.definition }),
        }).then((r) => r.json()),
      ]);
      if (validationRes.ok) setValidation(validationRes.validation);
      if (previewRes.ok) {
        setPreview(previewRes.preview);
        setBacktestConfigJson(JSON.stringify(previewRes.backtestConfig ?? data.backtestConfig ?? {}, null, 2));
      }
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
      const res = await fetch('/api/strategies/lab/validate', {
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
      setBacktestConfigJson(JSON.stringify(data.backtestConfig ?? {}, null, 2));
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
      const res = await fetch('/api/strategies/lab/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definition: { ...definition, source: tab === 'ai' ? 'ai' : 'no_code' },
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setSavedId(data.strategyId ?? data.id);
      setValidation(data.validation);
      setDsl(data.dsl);
      setJson(typeof data.json === 'string' ? data.json : JSON.stringify(data.json, null, 2));
      setBacktestConfigJson('');
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
      const res = await fetch(`/api/strategies/lab/${savedId}/backtest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
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

  const confirmBacktest = async () => {
    if (!savedId || !backtestId) { setError('Run a backtest before confirming'); return; }
    setLoading('confirm-backtest');
    setError('');
    try {
      const res = await fetch(`/api/strategies/lab/${savedId}/backtest/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backtestId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setBacktestPassed(Boolean(data.backtestPassed));
      if (!data.backtestPassed) setError(`Backtest is ${data.status}. Open Backtesting and wait for completion, then confirm again.`);
      await loadSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Backtest confirmation failed');
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
      setDsl(data.strategy.dsl ?? '');
      setJson(JSON.stringify(data.strategy.definition, null, 2));
      setBacktestConfigJson('');
    }
  };

  return (
    <AppShell title="Strategy Lab">
      <div className="page">
        <div className={styles.hero}>
          <div>
            <div className={styles.kicker}>Strategy Lab</div>
            <h1>Design, test, and refine trading strategies</h1>
            <p>
              Create no-code or AI-assisted strategies, validate rules, generate a backtest-ready config,
              and promote only tested strategies to paper trading.
            </p>
          </div>
          <div className={styles.heroCard}>
            <span>Workflow</span>
            <strong>Step {currentStep} of {pipeline.length}</strong>
            <small>{activeStepIndex === -1 ? 'Ready for paper deployment' : pipeline[activeStepIndex]?.label}</small>
          </div>
        </div>

        <div className={styles.pipeline}>
          {pipeline.map((step, i) => (
            <div
              key={step.key}
              className={step.done ? styles.pipelineStepDone : i === pipeline.findIndex((s) => !s.done) ? styles.pipelineStepActive : styles.pipelineStep}
            >
              <span>{step.done ? <CheckCircle2 size={13} /> : i + 1}</span>
              {step.label}
            </div>
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
          <div className={styles.builderColumn}>
            {tab === 'rule' ? (
              <NoCodeBuilder definition={definition} onChange={updateDefinition} />
            ) : (
              <div className={styles.aiPanel}>
                <div className={styles.aiHeader}>
                  <div>
                    <h3 className={styles.panelTitle}><Sparkles size={16} /> AI Strategy Builder</h3>
                    <p>
                      Describe the setup in plain English. The builder generates editable rules,
                      validation, DSL, JSON, and a backtest-ready config.
                    </p>
                  </div>
                </div>
                <textarea
                  className={styles.aiTextarea}
                  value={aiText}
                  onChange={(e) => setAiText(e.target.value)}
                  placeholder='Example: Create a bullish Fibonacci pullback strategy for NIFTY 500 with 2% stop loss, 2R target, and 0.5% risk per trade.'
                />
                <div className={styles.promptChips}>
                  {SAMPLE_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => setAiText(prompt)}>
                      {prompt}
                    </button>
                  ))}
                </div>
                <div className={styles.actions}>
                  <Button onClick={parseAi} disabled={!aiText.trim() || loading === 'parse'}>
                    {loading === 'parse' ? 'Generating…' : 'Generate Strategy'}
                  </Button>
                </div>
                {(definition.source === 'ai' || json) && (
                  <div className={styles.generatedRules}>
                    <div className={styles.generatedHeader}>
                      <span>Generated Editable Rules</span>
                      <small>Review and refine before saving</small>
                    </div>
                    <NoCodeBuilder definition={definition} onChange={updateDefinition} />
                  </div>
                )}
              </div>
            )}

            <div className={styles.actionBar}>
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
              <Button variant="secondary" onClick={confirmBacktest} disabled={!!loading || !savedId || !backtestId || backtestPassed}>
                Confirm Backtest
              </Button>
              <Button onClick={runDeploy} disabled={!!loading || !backtestPassed}>
                <Rocket size={14} /> Paper Deploy
              </Button>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}
          </div>

          <div className={styles.resultsColumn}>
            <ValidationPanel validation={validation} />
            <StrategyPreviewPanel preview={preview} dsl={dsl} json={json} backtestConfig={backtestConfigJson} />

            {!validation && !preview && !dsl && !json && !backtestConfigJson && (
              <Card compact>
                <div className={styles.emptyResults}>
                  <Sparkles size={20} />
                  <strong>Results will appear here</strong>
                  <span>Generate or preview a strategy to see validation, rule summary, DSL, JSON, and backtest config.</span>
                </div>
              </Card>
            )}

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
