'use client';
import { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { UPGRADE_MESSAGES } from '@/lib/constants/features';
import type { UserFeatures } from '@/types';

interface Props {
  feature:  string;
  features: UserFeatures | null;
  children: ReactNode;
  compact?: boolean;
}

export default function FeatureGate({ feature, features, children, compact }: Props) {
  // If features not loaded yet, show children (optimistic)
  if (!features) return <>{children}</>;

  // Admins / special case: __all means all features enabled
  if (features.features.__all) return <>{children}</>;

  const allowed = features.features[feature] ?? true;
  if (allowed) return <>{children}</>;

  const msg = UPGRADE_MESSAGES[feature];

  if (compact) {
    return (
      <div style={{ position: 'relative', display: 'inline-flex' }}>
        <div style={{ opacity: 0.35, pointerEvents: 'none', userSelect: 'none' }}>{children}</div>
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.7)', borderRadius: 8,
        }}>
          <Lock size={14} color="#94A3B8" />
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ opacity: 0.2, pointerEvents: 'none', userSelect: 'none', filter: 'blur(2px)' }}>
        {children}
      </div>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: 10, background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(4px)', borderRadius: 12, zIndex: 10, textAlign: 'center', padding: 24,
      }}>
        <Lock size={24} color="#94A3B8" />
        <div style={{ fontWeight: 700, fontSize: 15, color: '#1E3A5F' }}>
          {msg?.title ?? 'Premium Feature'}
        </div>
        <div style={{ fontSize: 13, color: '#64748B', maxWidth: 240 }}>
          {msg?.desc ?? 'Upgrade your plan to unlock this feature.'}
        </div>
        <a
          href="/settings?tab=plan"
          style={{
            background: '#1E3A5F', color: '#fff', padding: '8px 20px',
            borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none',
            display: 'inline-block', marginTop: 4,
          }}
        >
          Upgrade to {msg?.plan === 'elite' ? 'Elite' : 'Pro'}
        </a>
      </div>
    </div>
  );
}
