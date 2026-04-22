'use client';
import { useState, useEffect } from 'react';
import type { UserFeatures } from '@/types';

export function useFeatures(): { features: UserFeatures | null; loading: boolean; refetch: () => void } {
  const [features, setFeatures] = useState<UserFeatures | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [tick,     setTick]     = useState(0);

  useEffect(() => {
    fetch('/api/user/features')
      .then(r => r.json())
      .then(setFeatures)
      .catch(() => setFeatures(null))
      .finally(() => setLoading(false));
  }, [tick]);

  return { features, loading, refetch: () => setTick(t => t + 1) };
}

export function useIsAllowed(featureKey: string): boolean | null {
  const { features, loading } = useFeatures();
  if (loading || !features) return null;
  if (features.features.__all) return true;
  return features.features[featureKey] ?? true;
}
