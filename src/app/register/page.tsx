'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import styles from '../login/login.module.scss';
import Link from 'next/link';

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    if (!name || !email || !password) return setError('All fields are required');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== confirm) return setError('Passwords do not match');

    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'register', name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed');
        return;
      }
      router.push('/dashboard');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoMark}>Q</div>
          <div>
            <strong>Quantorus365</strong>
            <small>India Stock Intelligence</small>
          </div>
        </div>

        <h1 className={styles.title}>Create Account</h1>
        <p className={styles.sub}>Get started with Quantorus365</p>

        {error && <div className={styles.error}>{error}</div>}

        <form onSubmit={handleRegister} className={styles.form}>
          <div className={styles.field}>
            <label>Full Name</label>
            <input
              type="text" className="input" placeholder="John Doe"
              value={name} onChange={e => setName(e.target.value)}
              autoComplete="name" autoFocus
            />
          </div>
          <div className={styles.field}>
            <label>Email address</label>
            <input
              type="email" className="input" placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)}
              autoComplete="email"
            />
          </div>
          <div className={styles.field}>
            <label>Password</label>
            <div className={styles.pwWrap}>
              <input
                type={showPw ? 'text' : 'password'} className="input"
                placeholder="Min 8 characters" value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(s => !s)}>
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div className={styles.field}>
            <label>Confirm Password</label>
            <input
              type="password" className="input" placeholder="Repeat password"
              value={confirm} onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={loading}>
            {loading ? <><span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} /> Creating account...</> : 'Create Account'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13, color: '#5A6A7E' }}>
          Already have an account? <Link href="/login" style={{ color: '#00C9FF', fontWeight: 600 }}>Sign in</Link>
        </div>
      </div>
    </div>
  );
}
