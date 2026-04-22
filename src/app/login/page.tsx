'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Eye, EyeOff } from 'lucide-react';
import { authApi } from '@/lib/apiClient';
import Link from 'next/link';
import styles from './login.module.scss';

type Step = 'login' | '2fa';

export default function LoginPage() {
  const router = useRouter();
  const [step,     setStep]     = useState<Step>('login');
  const [userId,   setUserId]   = useState<number | null>(null);
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [otp,      setOtp]      = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    if (!email || !password) return setError('Email and password are required');
    setLoading(true); setError('');
    try {
      const data = await authApi.login(email, password) as any;
      if (data.requires2fa) { setUserId(data.userId); setStep('2fa'); }
      else router.push('/dashboard');
    } catch (err: any) {
      setError(err.data?.error || 'Login failed. Check your credentials.');
    } finally { setLoading(false); }
  }

  async function handle2fa(e: FormEvent) {
    e.preventDefault();
    if (!otp || otp.length !== 6) return setError('Enter the 6-digit code');
    setLoading(true); setError('');
    try {
      await authApi.verify2fa(userId!, otp);
      router.push('/dashboard');
    } catch (err: any) {
      setError(err.data?.error || 'Invalid code. Try again.');
    } finally { setLoading(false); }
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

        {step === 'login' ? (
          <>
            <h1 className={styles.title}>Welcome back</h1>
            <p className={styles.sub}>Sign in to your account</p>
            {error && <div className={styles.error}>{error}</div>}
            <form onSubmit={handleLogin} className={styles.form}>
              <div className={styles.field}>
                <label>Email address</label>
                <input
                  type="email" className="input" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)}
                  autoComplete="email" autoFocus
                />
              </div>
              <div className={styles.field}>
                <label>Password</label>
                <div className={styles.pwWrap}>
                  <input
                    type={showPw ? 'text' : 'password'} className="input"
                    placeholder="Your password" value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                  <button type="button" className={styles.eyeBtn} onClick={() => setShowPw(s => !s)}>
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className={styles.forgot}>
                <a href="/forgot-password">Forgot password?</a>
              </div>
              <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={loading}>
                {loading ? <><span className="spinner" style={{ width:16, height:16, borderWidth:2 }} /> Signing in…</> : 'Sign In'}
              </button>
            </form>
            <div style={{ textAlign:'center', marginTop:16, fontSize:13, color:'#5A6A7E' }}>
              Don&apos;t have an account? <Link href="/register" style={{ color:'#00C9FF', fontWeight:600 }}>Create one</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className={styles.title}>Two-factor auth</h1>
            <p className={styles.sub}>Enter the 6-digit code from your authenticator app</p>
            {error && <div className={styles.error}>{error}</div>}
            <form onSubmit={handle2fa} className={styles.form}>
              <div className={styles.field}>
                <label>Authentication Code</label>
                <input
                  className="input" placeholder="000000"
                  value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
                  maxLength={6} autoFocus
                  style={{ textAlign:'center', fontSize:26, letterSpacing:10, fontWeight:700 }}
                />
              </div>
              <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={loading || otp.length !== 6}>
                {loading ? <><span className="spinner" style={{ width:16, height:16, borderWidth:2 }} /> Verifying…</> : 'Verify Code'}
              </button>
              <button type="button" className={styles.back} onClick={() => { setStep('login'); setOtp(''); setError(''); }}>
                ← Back to login
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
