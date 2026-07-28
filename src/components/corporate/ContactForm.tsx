'use client';

import { useId, useState } from 'react';

type FormState = 'idle' | 'loading' | 'success' | 'error';

export default function ContactForm() {
  const [state, setState] = useState<FormState>('idle');
  const [error, setError] = useState('');
  const consentId = useId();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    setState('loading');
    setError('');

    const values = new FormData(form);
    const payload = {
      name: String(values.get('name') ?? ''),
      email: String(values.get('email') ?? ''),
      subject: String(values.get('subject') ?? ''),
      message: String(values.get('message') ?? ''),
      // Honeypot — leave empty; obscure name + no “company/website” label avoids autofill
      q_hp: String(values.get('q_hp') ?? ''),
    };

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        error?: string;
        success?: boolean;
        message?: string;
        data?: unknown;
      };
      if (!response.ok) throw new Error(result.error ?? 'Unable to send your message.');
      form.reset();
      setState('success');
      if (process.env.NODE_ENV === 'development') {
        console.info('[contact] API response', result);
      }
    } catch (submissionError) {
      setError(
        submissionError instanceof Error ? submissionError.message : 'Unable to send your message.',
      );
      setState('error');
    }
  }

  return (
    <form className="q-form" onSubmit={submit} noValidate>
      <label>
        Name
        <input required name="name" autoComplete="name" />
      </label>
      <label>
        Work email
        <input required type="email" name="email" autoComplete="email" />
      </label>
      <label className="full">
        Subject
        <input required name="subject" maxLength={160} autoComplete="off" />
      </label>
      <label className="full">
        Message
        <textarea required name="message" rows={6} minLength={10} maxLength={5000} />
      </label>

      {/* Hidden honeypot: no company/website wording (Chrome autofills those). */}
      <div className="q-honeypot" aria-hidden="true">
        <input
          name="q_hp"
          type="text"
          tabIndex={-1}
          autoComplete="new-password"
          defaultValue=""
          readOnly
          onFocus={(event) => event.currentTarget.removeAttribute('readonly')}
        />
      </div>

      <div className="q-consent full">
        <input id={consentId} required type="checkbox" name="consent" />
        <label htmlFor={consentId}>
          I agree that Quantorus may use this information to respond to my request.
        </label>
      </div>

      {state === 'success' && (
        <p className="q-success full" role="status">
          Thank you — your message has been sent.
        </p>
      )}
      {state === 'error' && (
        <p className="full" role="alert">
          {error}
        </p>
      )}

      <button className="q-talk" type="submit" disabled={state === 'loading'}>
        {state === 'loading' ? 'Sending…' : 'Send message'}
      </button>
    </form>
  );
}
