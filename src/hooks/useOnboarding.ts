'use client';
import { useState, useEffect } from 'react';
import type { UserOnboarding } from '@/types';

export function useOnboarding() {
  const [prefs,    setPrefs]    = useState<UserOnboarding | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [complete, setComplete] = useState(true); // assume complete until checked

  useEffect(() => {
    fetch('/api/user/onboarding')
      .then(r => r.json())
      .then(d => {
        setPrefs(d.preferences);
        setComplete(d.onboarding_completed ?? false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const markComplete = () => setComplete(true);

  return { prefs, loading, onboardingComplete: complete, markComplete };
}
