'use client';

import { useQuery } from '@tanstack/react-query';
import type { TrustRegimeSnapshot } from '@/lib/trust-layer/types';

export interface RegimeResponse extends TrustRegimeSnapshot {
  categoryLabel: string;
  confidenceModifier: number;
  impactsConfidence: boolean;
  computedBeforeSignals: boolean;
  categories: {
    bullish: boolean;
    bearish: boolean;
    sideways: boolean;
    highVolatility: boolean;
  };
}

export function useTrustRegime() {
  return useQuery({
    queryKey: ['market-regime'],
    queryFn: async () => {
      const res = await fetch('/api/market-regime', { cache: 'no-store', credentials: 'include' });
      if (!res.ok) throw new Error('Regime fetch failed');
      const body = await res.json();
      return body.data as RegimeResponse;
    },
    refetchInterval: 120_000,
  });
}
