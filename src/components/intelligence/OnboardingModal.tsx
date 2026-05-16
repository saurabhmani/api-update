'use client';
import { useState } from 'react';
import type { TraderType, RiskProfile, AlertMode } from '@/types';

interface Props {
  onComplete: (prefs: any) => void;
}

const STEPS = ['trader_type', 'risk_profile', 'alert_mode', 'done'] as const;

export default function OnboardingModal({ onComplete }: Props) {
  const [step,    setStep]    = useState(0);
  const [saving,  setSaving]  = useState(false);
  const [prefs,   setPrefs]   = useState({
    trader_type:        'active_trader' as TraderType,
    preferred_segments: ['equities'] as string[],
    risk_profile:       'medium' as RiskProfile,
    alert_mode:         'instant' as AlertMode,
    ui_mode:            'pro' as const,
  });

  const next = () => setStep(s => Math.min(s + 1, STEPS.length - 1));

  const handleDone = async () => {
    setSaving(true);
    try {
      await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
      onComplete(prefs);
    } finally { setSaving(false); }
  };

  const set = (key: string, val: unknown) => setPrefs(p => ({ ...p, [key]: val }));

  const cardStyle = (selected: boolean): React.CSSProperties => ({
    border: `2px solid ${selected ? '#1E3A5F' : '#E2E8F0'}`,
    background: selected ? '#EEF4FB' : '#fff',
    borderRadius: 10, padding: '14px 18px', cursor: 'pointer',
    transition: 'all 0.15s', marginBottom: 10,
    display: 'flex', alignItems: 'flex-start', gap: 12,
  });

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: 16,
    }}>
      <div style={{
        background: '#fff', borderRadius: 16, padding: 32,
        width: '100%', maxWidth: 500, boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
      }}>
        {/* Progress */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 28 }}>
          {[0,1,2].map(i => (
            <div key={i} style={{ flex: 1, height: 4, borderRadius: 99, background: i <= step ? '#1E3A5F' : '#E2E8F0', transition: 'background 0.3s' }} />
          ))}
        </div>

        {/* Step 0: Trader type */}
        {step === 0 && (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1E3A5F', marginBottom: 6 }}>How do you trade?</div>
            <div style={{ fontSize: 14, color: '#64748B', marginBottom: 20 }}>We'll personalise your signal feed based on this.</div>
            {[
              { val:'beginner',      emoji:'🌱', title:'Beginner',       desc:'Learning the ropes, simple signals preferred' },
              { val:'active_trader', emoji:'⚡', title:'Active Trader',  desc:'Daily/swing trading, full signals and setups' },
              { val:'options_trader',emoji:'📊', title:'Options Trader', desc:'Focus on options, OI analysis, and greeks' },
            ].map(({ val, emoji, title, desc }) => (
              <div key={val} style={cardStyle(prefs.trader_type === val)} onClick={() => set('trader_type', val)}>
                <span style={{ fontSize: 24 }}>{emoji}</span>
                <div>
                  <div style={{ fontWeight: 700, color: '#1E3A5F' }}>{title}</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>{desc}</div>
                </div>
              </div>
            ))}
            <button onClick={next} style={{ width: '100%', background: '#1E3A5F', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontWeight: 700, fontSize: 15, cursor: 'pointer', marginTop: 8 }}>
              Continue →
            </button>
          </>
        )}

        {/* Step 1: Risk profile */}
        {step === 1 && (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1E3A5F', marginBottom: 6 }}>What's your risk appetite?</div>
            <div style={{ fontSize: 14, color: '#64748B', marginBottom: 20 }}>This affects how signals are filtered for you.</div>
            {[
              { val:'low',    emoji:'🛡️', title:'Conservative', desc:'Prioritise high-confidence, low-risk signals' },
              { val:'medium', emoji:'⚖️', title:'Moderate',     desc:'Balanced mix of opportunity and caution' },
              { val:'high',   emoji:'🚀', title:'Aggressive',   desc:'Show all signals including higher-risk setups' },
            ].map(({ val, emoji, title, desc }) => (
              <div key={val} style={cardStyle(prefs.risk_profile === val)} onClick={() => set('risk_profile', val)}>
                <span style={{ fontSize: 24 }}>{emoji}</span>
                <div>
                  <div style={{ fontWeight: 700, color: '#1E3A5F' }}>{title}</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>{desc}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(0)} style={{ flex: 1, background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 10, padding: '12px 0', fontWeight: 600, cursor: 'pointer' }}>← Back</button>
              <button onClick={next} style={{ flex: 2, background: '#1E3A5F', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontWeight: 700, cursor: 'pointer' }}>Continue →</button>
            </div>
          </>
        )}

        {/* Step 2: Alert mode */}
        {step === 2 && (
          <>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1E3A5F', marginBottom: 6 }}>How do you want alerts?</div>
            <div style={{ fontSize: 14, color: '#64748B', marginBottom: 20 }}>You can change this anytime in settings.</div>
            {[
              { val:'instant', emoji:'🔔', title:'Instant',  desc:'Get alerts as soon as signals fire' },
              { val:'digest',  emoji:'📋', title:'Digest',   desc:'Batched alerts a few times per day' },
              { val:'limited', emoji:'🔕', title:'Limited',  desc:'Only the most important alerts' },
            ].map(({ val, emoji, title, desc }) => (
              <div key={val} style={cardStyle(prefs.alert_mode === val)} onClick={() => set('alert_mode', val)}>
                <span style={{ fontSize: 24 }}>{emoji}</span>
                <div>
                  <div style={{ fontWeight: 700, color: '#1E3A5F' }}>{title}</div>
                  <div style={{ fontSize: 12, color: '#64748B' }}>{desc}</div>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
              <button onClick={() => setStep(1)} style={{ flex: 1, background: '#F1F5F9', color: '#475569', border: 'none', borderRadius: 10, padding: '12px 0', fontWeight: 600, cursor: 'pointer' }}>← Back</button>
              <button onClick={handleDone} disabled={saving} style={{ flex: 2, background: '#16A34A', color: '#fff', border: 'none', borderRadius: 10, padding: '12px 0', fontWeight: 700, cursor: 'pointer' }}>
                {saving ? 'Saving...' : '✓ Get Started'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
