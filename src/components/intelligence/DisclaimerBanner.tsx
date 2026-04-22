'use client';
import { Info } from 'lucide-react';
import { DISCLAIMERS } from '@/lib/constants/disclaimer';

type Variant = 'short' | 'standard' | 'signal' | 'setup' | 'footer';

interface Props {
  variant?: Variant;
  className?: string;
}

export default function DisclaimerBanner({ variant = 'short', className }: Props) {
  const textMap: Record<Variant, string> = {
    short:    DISCLAIMERS.SHORT,
    standard: DISCLAIMERS.STANDARD,
    signal:   DISCLAIMERS.SIGNAL_CARD,
    setup:    DISCLAIMERS.SETUP_CARD,
    footer:   DISCLAIMERS.FOOTER,
  };

  if (variant === 'footer') {
    return (
      <div style={{ borderTop: '1px solid #E2E8F0', padding: '12px 20px', fontSize: 11, color: '#94A3B8', lineHeight: 1.6 }}>
        {textMap.footer}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        background: '#FFFBEB', border: '1px solid #FDE68A',
        borderRadius: 8, padding: '8px 12px',
        fontSize: 11, color: '#92400E', lineHeight: 1.5,
      }}
    >
      <Info size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      {textMap[variant]}
    </div>
  );
}
