'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  parseCompletionCodeFromHash,
  stripCodeFragmentFromUrl,
} from '@/lib/kite/auth-complete-fragment';
import {
  redeemCompletionCode,
  resolveCompletionCode,
} from '@/lib/kite/auth-complete-redemption';

type AuthState = 'completing' | 'success' | 'failure';

function stripCodeFromUrl(): void {
  const nextUrl = stripCodeFragmentFromUrl(window.location.href);
  window.history.replaceState({}, '', nextUrl);
}

export default function KiteAuthCompletePage() {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [state, setState] = useState<AuthState>('completing');
  const [message, setMessage] = useState('Completing Kite authentication…');

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      const fragmentCode = parseCompletionCodeFromHash(window.location.hash);
      const completionCode = resolveCompletionCode(fragmentCode);
      if (!completionCode) {
        if (!cancelled) {
          setState('failure');
          setMessage('Missing completion code. Return to Data Source Login and start Kite login again.');
        }
        return;
      }

      stripCodeFromUrl();

      const result = await redeemCompletionCode(completionCode);
      if (cancelled) return;

      if (result.ok === false) {
        setState('failure');
        setMessage(result.message);
        return;
      }

      setState('success');
      setMessage('Kite connected successfully. Redirecting to data sources…');
      routerRef.current.replace('/data-source?connected=1&broker=zerodha');
    }

    void complete();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <section
        role="status"
        aria-live="polite"
        aria-busy={state === 'completing'}
        style={{ maxWidth: 420, textAlign: 'center' }}
      >
        <h1 style={{ fontSize: '1.25rem', marginBottom: 12 }}>
          {state === 'completing' && 'Completing authentication'}
          {state === 'success' && 'Authentication successful'}
          {state === 'failure' && 'Authentication failed'}
        </h1>
        <p>{message}</p>
      </section>
    </main>
  );
}
