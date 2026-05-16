'use client';

import {
  TrendingUp, TrendingDown, Minus, Check,
  AlertTriangle, Shield, Copy,
} from 'lucide-react';
import { fmt, clsx }       from '@/lib/utils';
import ScoreBar             from '../shared/ScoreBar';
import type { StockData }   from '../types';
import s from '../StockDashboard.module.scss';

interface Props {
  data: StockData;
  onCopyPlan: () => void;
  copied: boolean;
}

// ── Humanized labels for backend codes ─────────────────────────
// Raw backend values (NO_STRATEGY, capital_preservation, reject) are
// not user-readable. The maps below translate them for the UI. Any
// unknown key falls through to a title-cased version of the raw key.
const REJECTION_LABEL: Record<string, string> = {
  NO_STRATEGY:                'No high-confidence setup',
  no_strategy:                'No high-confidence setup',
  capital_preservation:       'Capital Preservation',
  reject:                     'Low Conviction',
  confidence_below_threshold: 'Confidence below threshold',
  risk_score_exceeded:        'Risk too high for current stance',
  risk_reward_insufficient:   'Reward/risk not compelling',
  liquidity_insufficient:     'Thin liquidity — avoid',
  stop_distance_invalid:      'Invalid stop distance',
  portfolio_fit_rejected:     'Poor portfolio fit',
  scenario_blocked:           'Scenario not favorable',
  stance_restricted:          'Market stance restrictive',
  regime_incompatible:        'Regime mismatch',
  manipulation_rejected:      'Manipulation risk',
  manipulation_penalized:     'Manipulation risk (penalized)',
  data_quality:               'Data quality issue',
};

const CONVICTION_LABEL: Record<string, string> = {
  high_conviction: 'High Conviction',
  actionable:      'Actionable',
  watchlist:       'Watchlist',
  reject:          'Low Conviction',
};

const STANCE_LABEL: Record<string, string> = {
  aggressive:           'Aggressive',
  selective:            'Selective',
  defensive:            'Defensive',
  capital_preservation: 'Capital Preservation',
};

function humanize(input: string): string {
  return input.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function rejectionLabel(code: string): string {
  return REJECTION_LABEL[code] ?? REJECTION_LABEL[code.toLowerCase()] ?? humanize(code);
}

function convictionLabel(band: string | null): string | null {
  if (!band) return null;
  return CONVICTION_LABEL[band.toLowerCase()] ?? humanize(band);
}

function stanceLabel(stance: string | null): string | null {
  if (!stance) return null;
  return STANCE_LABEL[stance.toLowerCase()] ?? humanize(stance);
}

function scenarioLabel(tag: string | null): string | null {
  if (!tag) return null;
  if (tag.toUpperCase() === 'NO_STRATEGY') return 'No high-confidence setup';
  return humanize(tag.toLowerCase());
}

export default function DecisionPanel({ data, onCopyPlan, copied }: Props) {
  const dir         = data.signal_type ?? 'HOLD';
  const conf        = data.confidence ?? 0;
  const score       = data.score ?? 0;

  // Prefer real engine values over derived placeholders. Fall back
  // only when the signal payload doesn't carry the field — which is
  // the case for legacy `signals`-table reads (no Phase 3 metadata).
  const riskScore   = data.risk_score    ?? Math.min(100, Math.max(0, 100 - conf));
  const fitScore    = data.portfolio_fit ?? Math.min(100, Math.max(0, score * 0.8 + conf * 0.2));

  const status      = data.signal_status;
  const conviction  = convictionLabel(data.conviction_band);
  const scenario    = scenarioLabel(data.scenario_tag);
  const stance      = stanceLabel(data.market_stance);

  // Verdict-honesty fields. The signals table surfaces rows tagged
  // is_relaxed=true via the relaxed_bypass even when the underlying
  // row carries a blocking classification (WATCHLIST_ONLY / NO_TRADE)
  // or execution_allowed=false. Without these inputs, DecisionPanel
  // would render "Ready to Execute" for an APPROVED_SIGNAL row whose
  // classification is NO_TRADE — the user's complaint that "the
  // verdict on the detail page contradicts the table" stems from
  // this gap. We render the conflict honestly instead of letting
  // signal_status alone decide.
  const cls               = String(data.classification ?? '').toUpperCase();
  const rawCls            = String(data.raw_classification ?? '').toUpperCase();
  const blockingCls       = cls === 'NO_TRADE' || cls === 'WATCHLIST_ONLY'
                         || rawCls === 'NO_TRADE' || rawCls === 'WATCHLIST_ONLY';
  const execBlocked       = data.execution_allowed === false;
  const fromRelaxedPool   = data.is_relaxed === true || data.is_scanner_candidate === true;
  const stateChanged      = data.signal_state_changed === true;
  // Caveats override "Ready to Execute" → amber "Approved (with caveats)"
  // so the green-check verdict isn't shown for a row the engine has
  // already flagged as not institutionally tradable. The detail panel
  // and the signals-table row badge derive from the same flags so
  // both surfaces tell the same story.
  const hasCaveats        = (status === 'APPROVED_SIGNAL') && (blockingCls || execBlocked || fromRelaxedPool);

  // Status → readiness variant + copy. Replaces the old binary
  // "Ready / Caution / Not Recommended" derived purely from confidence.
  // Engine-derived signal_status accounts for rejections, conviction
  // band, and market stance — but `hasCaveats` covers the relaxed-
  // pool case where signal_status alone overstates the verdict.
  // Spec UX-PROFESSIONAL-LABELS — institutional terminology shared
  // between the signals-table badge and this panel. The label set
  // is "Trade Ready" / "Awaiting Confirmation" / "Early Opportunity"
  // / "Emerging Opportunity" / "No trade — wait for setup". Internal
  // enums (APPROVED_SIGNAL / DEVELOPING_SETUP / NO_TRADE) are never
  // surfaced verbatim. Both surfaces use the SAME mapping so a row
  // labelled "Emerging Opportunity" in the table cannot read as
  // "Setup is developing" in the panel.
  const readiness =
    hasCaveats
      ? {
          variant: 'watch' as const,
          icon:    AlertTriangle,
          label:   data.is_scanner_candidate === true
                    ? 'Emerging Opportunity'
                    : fromRelaxedPool
                      ? 'Early Opportunity'
                      : 'Approved with caveats — verify before entry',
        }
    : status === 'APPROVED_SIGNAL'
      ? { variant: 'go'    as const, icon: Check,           label: 'Trade Ready' }
    : status === 'DEVELOPING_SETUP'
      ? {
          variant: 'watch' as const,
          icon:    AlertTriangle,
          label:   data.is_scanner_candidate === true
                    ? 'Emerging Opportunity'
                    : 'Awaiting Confirmation',
        }
    : status === 'NO_TRADE'
      ? { variant: 'block' as const, icon: Shield,          label: 'No trade — wait for setup' }
    : conf >= 65
      ? { variant: 'go'    as const, icon: Check,           label: 'Trade Ready' }
    : conf >= 45
      ? { variant: 'watch' as const, icon: AlertTriangle,   label: 'Proceed with Caution' }
    : { variant: 'block' as const, icon: Shield,          label: 'Not Recommended' };

  // Sub-line that explains the caveat when one is present. Surfaces
  // classification / execution / relaxed-pool context so the user
  // understands WHY the verdict isn't a clean green check, even
  // though the table listed this symbol in the APPROVED tab.
  const verdictNote: string | null = (() => {
    if (data.signal_note) return data.signal_note;
    if (stateChanged && data.downgrade_reason) {
      return `Signal changed since generation: ${data.downgrade_reason}`;
    }
    if (hasCaveats) {
      const parts: string[] = [];
      if (fromRelaxedPool) parts.push('surfaced via relaxed/scanner pool');
      if (blockingCls)     parts.push(`classification=${cls || rawCls}`);
      if (execBlocked)     parts.push('execution_allowed=false');
      return `Engine flagged: ${parts.join(' · ')}`;
    }
    return null;
  })();

  const showPlan = status !== 'NO_TRADE' && data.signal_type;

  return (
    <aside className={s.decisionPanel}>

      {/* Signal Intelligence */}
      <div className={s.dpCardAccent}>
        <div className={s.dpLabel}>Signal Intelligence</div>

        {data.signal_type ? (
          <>
            <div className={clsx(s.dpVerdict, s[`dpVerdict--${dir}`])}>
              {dir === 'BUY' ? <TrendingUp size={16} /> : dir === 'SELL' ? <TrendingDown size={16} /> : <Minus size={16} />}
              {dir}
            </div>

            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Confidence</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={conf} />
                {conf}%
              </span>
            </div>
            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Risk Score</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={riskScore} variant={riskScore <= 40 ? 'success' : riskScore <= 60 ? 'warning' : 'danger'} />
                {riskScore}
              </span>
            </div>
            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Portfolio Fit</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={fitScore} />
                {Math.round(fitScore)}
              </span>
            </div>
            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Q365 Score</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={score} />
                {score > 0 ? score.toFixed(0) : '-'}
              </span>
            </div>

            {scenario && (
              <div className={s.dpRow}>
                <span className={s.dpRowLabel}>Scenario</span>
                <span className={s.dpRowValue}>{scenario}</span>
              </div>
            )}
            {stance && (
              <div className={s.dpRow}>
                <span className={s.dpRowLabel}>Market Stance</span>
                <span className={s.dpRowValue}>{stance}</span>
              </div>
            )}
            {conviction && (
              <div className={s.dpRow}>
                <span className={s.dpRowLabel}>Conviction</span>
                <span className={s.dpRowValue}>{conviction}</span>
              </div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#94A3B8', fontSize: 13 }}>
            No active signal
          </div>
        )}
      </div>

      {/* Execution readiness */}
      {data.signal_type && (
        <div className={s.dpCard}>
          <div className={s.dpLabel}>Execution Readiness</div>
          <div className={clsx(s.dpReadiness, s[`dpReadiness--${readiness.variant}`])}>
            <readiness.icon size={14} />
            {readiness.label}
          </div>
          {/* Verdict note — surfaces the caveat when the signals
              table showed this row as APPROVED but the underlying
              row carries a blocking classification, an exec block,
              or came from the relaxed/scanner pool. Without this
              the table+detail surfaces appeared to disagree. */}
          {verdictNote && (
            <div
              style={{
                marginTop: 6,
                fontSize:  12,
                color:     '#A16207',
                lineHeight: 1.4,
              }}
            >
              {verdictNote}
            </div>
          )}
        </div>
      )}

      {/* Developing-setup / rejection narrative */}
      {data.signal_type && (status === 'DEVELOPING_SETUP' || status === 'NO_TRADE') && (
        <div className={s.dpCard}>
          <div className={s.dpLabel}>
            {status === 'DEVELOPING_SETUP' ? 'Why it’s not yet actionable' : 'Why there’s no trade'}
          </div>
          {data.rejection_codes.length > 0 ? (
            <div className={s.dpEvent}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {data.rejection_codes.map(rejectionLabel).join(' · ')}
                {status === 'DEVELOPING_SETUP' && ' — wait for breakout or confirmation.'}
              </span>
            </div>
          ) : (
            <div className={s.dpEvent}>
              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                {status === 'DEVELOPING_SETUP'
                  ? 'Setup is developing — wait for breakout or confirmation.'
                  : 'No high-confidence setup. Monitor price action for a cleaner entry.'}
              </span>
            </div>
          )}

          {data.rejection_reasons.length > 0 && (
            <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px', fontSize: 12, color: '#64748B', lineHeight: 1.55 }}>
              {data.rejection_reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Trade Plan — hidden when NO_TRADE */}
      {showPlan && (
        <div className={s.dpCard}>
          <div className={s.dpLabel}>Trade Plan</div>
          <div className={s.dpLevels}>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Entry</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--entry'])}>
                {data.entry_price ? fmt.currency(data.entry_price) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Stop Loss</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--stop'])}>
                {data.stop_loss ? fmt.currency(data.stop_loss) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Target 1</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--target'])}>
                {data.target1 ? fmt.currency(data.target1) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Target 2</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--target'])}>
                {data.target2 ? fmt.currency(data.target2) : '-'}
              </div>
            </div>
          </div>

          {data.risk_reward != null && (
            <div className={s.dpRR}>
              <span className={s.dpRRLabel}>R : R</span>
              <span className={s.dpRRValue}>1:{data.risk_reward}</span>
            </div>
          )}
        </div>
      )}

      {/* Portfolio Fit */}
      <div className={s.dpCard}>
        <div className={s.dpLabel}>Portfolio Fit</div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Fit Score</span>
          <span className={s.dpRowValue}>{Math.round(fitScore)}/100</span>
        </div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Size</span>
          <span className={s.dpRowValue}>2-3%</span>
        </div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Correlation</span>
          <span className={s.dpRowValue}>{riskScore < 40 ? 'Low' : riskScore < 60 ? 'Moderate' : 'High'}</span>
        </div>
      </div>

      {/* Event Risk */}
      <div className={s.dpCard}>
        <div className={s.dpLabel}>Event Risk</div>
        <div className={s.dpEvent}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>No major events detected. Verify corporate announcements before execution.</span>
        </div>
      </div>

      {/* Copy */}
      <button className={clsx(s.dpCopy, copied && s['dpCopy--done'])} onClick={onCopyPlan}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy Trade Plan'}
      </button>
    </aside>
  );
}
