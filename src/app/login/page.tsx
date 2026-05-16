'use client';
import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Eye,
  EyeOff,
  Mail,
  Lock,
  Shield,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Github,
} from 'lucide-react';
import { FaApple } from "react-icons/fa";
import { authApi } from '@/lib/apiClient';
import Link from 'next/link';
import styles from './login.module.scss';

type Step = 'login' | '2fa';

function GoogleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.9 6.2 29.7 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.9 6.2 29.7 4 24 4 16.3 4 9.7 8.4 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.6 0 10.7-2.1 14.5-5.6l-6.7-5.5C29.7 34.4 27 35 24 35c-5.3 0-9.7-3.4-11.3-8l-6.6 5.1C9.5 39.5 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.5l6.7 5.5c-.5.5 7.2-5.3 7.2-15 0-1.3-.1-2.4-.4-3.5z"/>
    </svg>
  );
}

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
      <div className={styles.modal}>
        {/* ── LEFT BRAND PANEL ───────────────────────────────── */}
        <aside className={styles.brandPanel} aria-hidden="true">
          <div className={styles.brandHeader}>
            <span className={styles.brandDot} aria-hidden="true" />
            <span className={styles.brandName}>
              quantorus<span className={styles.brandNameAccent}>365</span>
            </span>
          </div>

          <div className={styles.brandBody}>
            <h2 className={styles.brandTitle}>
              Welcome Back to
              <span>Quantorus365</span>
            </h2>
            <div className={styles.accentBar} />
            <p className={styles.brandSubtitle}>
              Sign in to continue to your India Stock Intelligence Platform.
            </p>
          </div>

          <ul className={styles.brandFooter}>
            <li className={styles.brandFooterItem}>
              <CheckCircle2 size={14} /> Real-time NSE &amp; BSE market data
            </li>
            <li className={styles.brandFooterItem}>
              <CheckCircle2 size={14} /> AI-powered signals &amp; analytics
            </li>
            <li className={styles.brandFooterItem}>
              <CheckCircle2 size={14} /> Bank-grade encryption · 2FA secured
            </li>
          </ul>

          {/* ── Decorative: floating market ticker chips ───────── */}
          <div className={`${styles.tickerChip} ${styles.tickerChip1}`} aria-hidden="true">
            <span className={styles.tickerName}>NIFTY 50</span>
            <span className={styles.tickerUp}>+1.42%</span>
          </div>
          <div className={`${styles.tickerChip} ${styles.tickerChip2}`} aria-hidden="true">
            <span className={styles.tickerName}>SENSEX</span>
            <span className={styles.tickerUp}>+0.85%</span>
          </div>
          <div className={`${styles.tickerChip} ${styles.tickerChip3}`} aria-hidden="true">
            <span className={styles.tickerName}>BANKNIFTY</span>
            <span className={styles.tickerDown}>−0.23%</span>
          </div>

          {/* ── Decorative: market chart line ─────────────────── */}
          <svg
            className={styles.brandChart}
            viewBox="0 0 600 160"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="qChartFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#00C9FF" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#00C9FF" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="qChartStroke" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2563EB" />
                <stop offset="100%" stopColor="#00C9FF" />
              </linearGradient>
            </defs>
            <path
              d="M0,120 L60,108 L120,112 L180,88 L240,96 L300,72 L360,80 L420,52 L480,60 L540,36 L600,42 L600,160 L0,160 Z"
              fill="url(#qChartFill)"
            />
            <path
              d="M0,120 L60,108 L120,112 L180,88 L240,96 L300,72 L360,80 L420,52 L480,60 L540,36 L600,42"
              stroke="url(#qChartStroke)"
              strokeWidth="2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <div className={styles.glowOrb} />
          <div className={styles.glowOrbTop} />
        </aside>

        {/* ── RIGHT FORM PANEL ───────────────────────────────── */}
        <section className={styles.formPanel}>
          {step === 'login' ? (
            <div className={styles.formInner}>
              <header className={styles.formHeader}>
                <h1 className={styles.title}>Sign in</h1>
                <p className={styles.sub}>
                  Welcome back — please enter your details.
                </p>
              </header>

              <div className={styles.socialRow}>
                <button type="button" className={styles.socialBtn} aria-label="Continue with Google">
                  <span className={styles.socialIcon}><GoogleIcon size={18} /></span>
                  <span>Continue with Google</span>
                </button>
                <button type="button" className={styles.socialBtn} aria-label="Continue with Apple">
                  <span className={styles.socialIcon}>
                    <FaApple size={18} fill="currentColor" strokeWidth={0} />
                  </span>
                  <span>Continue with Apple</span>
                </button>
                <button type="button" className={styles.socialBtn} aria-label="Continue with GitHub">
                  <span className={styles.socialIcon}><Github size={18} /></span>
                  <span>Continue with GitHub</span>
                </button>
              </div>

              <div className={styles.divider}><span>or sign in with email</span></div>

              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}

              <form onSubmit={handleLogin} className={styles.form} noValidate>
                <div className={styles.field}>
                  <label htmlFor="email">Email address</label>
                  <div className={styles.inputWrap}>
                    <Mail size={18} className={styles.leadingIcon} />
                    <input
                      id="email"
                      type="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                </div>

                <div className={styles.field}>
                  <label htmlFor="password">Password</label>
                  <div className={styles.inputWrap}>
                    <Lock size={18} className={styles.leadingIcon} />
                    <input
                      id="password"
                      type={showPw ? 'text' : 'password'}
                      placeholder="Enter your password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                    <button
                      type="button"
                      className={styles.eyeBtn}
                      onClick={() => setShowPw(s => !s)}
                      aria-label={showPw ? 'Hide password' : 'Show password'}
                    >
                      {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div className={styles.formRow}>
                  <label className={styles.remember}>
                    <input type="checkbox" />
                    <span>Keep me signed in</span>
                  </label>
                  <Link href="/forgot-password" className={styles.forgot}>
                    Forgot password?
                  </Link>
                </div>

                <button type="submit" className={styles.submitBtn} disabled={loading}>
                  {loading ? (
                    <>
                      <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                      <span>Signing in…</span>
                    </>
                  ) : (
                    <>
                      <span>Sign In</span>
                      <ArrowRight size={18} />
                    </>
                  )}
                </button>
              </form>

              <p className={styles.signupRow}>
                Not a member yet? <Link href="/register">Sign Up</Link>
              </p>
            </div>
          ) : (
            <div className={`${styles.formInner} ${styles.twoFa}`}>
              <div className={styles.shieldIcon}>
                <Shield size={28} strokeWidth={2} />
              </div>

              <header className={styles.formHeader}>
                <h1 className={styles.title}>Two-factor authentication</h1>
                <p className={styles.sub}>
                  Enter the 6-digit code from your authenticator app to continue.
                </p>
              </header>

              {error && (
                <div className={styles.error} role="alert">
                  {error}
                </div>
              )}

              <form onSubmit={handle2fa} className={styles.form} noValidate>
                <div className={styles.field}>
                  <label htmlFor="otp" className={styles.srOnly}>Authentication code</label>
                  <input
                    id="otp"
                    className={styles.otpInput}
                    placeholder="000000"
                    value={otp}
                    onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    maxLength={6}
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </div>

                <button
                  type="submit"
                  className={styles.submitBtn}
                  disabled={loading || otp.length !== 6}
                >
                  {loading ? (
                    <>
                      <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                      <span>Verifying…</span>
                    </>
                  ) : (
                    <>
                      <span>Verify Code</span>
                      <ArrowRight size={18} />
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className={styles.back}
                  onClick={() => { setStep('login'); setOtp(''); setError(''); }}
                >
                  <ArrowLeft size={14} /> Back to login
                </button>
              </form>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
