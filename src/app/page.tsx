import Link from 'next/link';
import { ENGINES, INSIGHTS } from '@/lib/data';
import styles from '@/styles/Home.module.scss';
import Nav from '@/components/layout/Nav';
import Footer from '@/components/layout/Footer';

const SHELL: React.CSSProperties = {
  minHeight: '100vh',
  background: '#0A1628',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-body)',
};

const CONTAINER: React.CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  padding: '0 24px',
};

const SECTION: React.CSSProperties = {
  padding: '96px 0',
};

const SECTION_LABEL: React.CSSProperties = {
  display:       'inline-block',
  fontSize:      11,
  letterSpacing: 2,
  textTransform: 'uppercase',
  color:         'var(--gold)',
  fontFamily:    'var(--font-mono)',
  marginBottom:  16,
};

function pill(active: boolean, dot: boolean): React.CSSProperties {
  return {
    display:       'inline-flex',
    alignItems:    'center',
    gap:           8,
    padding:       '6px 12px',
    borderRadius:  999,
    fontSize:      11,
    fontWeight:    600,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    background:    active ? 'rgba(201,168,76,0.10)' : 'rgba(255,255,255,0.04)',
    border:        `1px solid ${active ? 'rgba(201,168,76,0.30)' : 'var(--border-subtle)'}`,
    color:         active ? 'var(--gold)' : 'var(--text-muted)',
    ...(dot
      ? { boxShadow: 'inset 8px 0 0 -5px var(--gold)' }
      : {}),
  };
}

function btn(variant: 'primary' | 'outline' | 'ghost'): React.CSSProperties {
  const base: React.CSSProperties = {
    display:        'inline-flex',
    alignItems:     'center',
    gap:            8,
    padding:        '12px 22px',
    fontSize:       14,
    fontWeight:     600,
    borderRadius:   4,
    textDecoration: 'none',
    transition:     'all 0.2s ease',
    cursor:         'pointer',
  };
  if (variant === 'primary') {
    return { ...base, background: 'var(--gold)', color: '#0A1628', border: '1px solid var(--gold)' };
  }
  if (variant === 'outline') {
    return { ...base, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' };
  }
  return { ...base, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid transparent', padding: '10px 16px' };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span style={SECTION_LABEL}>{children}</span>;
}

function Hero() {
  return (
    <section className={styles.heroSection}>
      <div aria-hidden="true" className={styles.heroGrid} />
      <div aria-hidden="true" className={styles.heroGlow} />

      <div style={{ ...CONTAINER, position: 'relative', zIndex: 1 }} className={styles.heroContainer}>
        <div className={styles.heroInner}>

          <div className={styles.heroStatus}>
            <span style={pill(true, true)}>
              Intelligence Platform — In Active Development
            </span>
          </div>

          <h1 className={styles.heroHeadline} style={{ fontSize: 'clamp(2.2rem, 4.5vw, 3.6rem)', fontWeight: 700, letterSpacing: -1, lineHeight: 1.15, color: 'var(--text-primary)' }}>
            Institutional-grade trading intelligence.
            <span className={styles.heroHeadlineAccent}>
              Built with discipline.
            </span>
          </h1>

          <p className={styles.heroLede} style={{ color: 'var(--text-secondary)' }}>
            Quantorus365 is a modular trading intelligence platform being built for professional and institutional market participants. Where signal quality, risk discipline, and portfolio awareness form the foundation of every decision.
          </p>

          <div className={styles.heroCtas} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 64 }}>
            <Link href="/dashboard" style={btn('primary')}>
              Explore Platform
            </Link>
            <Link href="/login" style={btn('outline')}>
              Access Platform
            </Link>
          </div>

          <div className={styles.heroMetrics} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 32, maxWidth: 600 }}>
            {[
              { num: '11', label: 'Gate Rejection Engine' },
              { num: '9',  label: 'Confidence Components' },
              { num: '5',  label: 'Intelligence Modules' },
            ].map(({ num, label }) => (
              <div key={label}>
                <div className={styles.heroMetricNum} style={{ fontSize: 38, fontWeight: 300, color: 'var(--gold)', fontFamily: 'var(--font-mono)' }}>
                  {num}
                </div>
                <div className={styles.heroMetricLabel} style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProblemSection() {
  const problems = [
    { title: 'Fragmented tooling creates fragmented thinking', body: 'Most professional traders operate across disconnected platforms — charting here, news there, positions elsewhere. The absence of structural coherence is not merely inconvenient; it produces systematically worse decisions.' },
    { title: 'Signal volume is not signal quality',            body: 'The market intelligence industry optimises for output. More signals, more alerts, more data. Institutional decision systems work from the opposite premise: aggressive filtering, structural rejection discipline, and only emitting what is truly sound.' },
    { title: 'Risk remains a display, not a gatekeeper',       body: 'In most retail and prosumer tools, risk score is a number shown after a signal is generated. In properly constructed systems, risk is a gatekeeper that determines whether a signal is permitted to reach the user at all.' },
  ];

  return (
    <section style={{ ...SECTION, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={CONTAINER}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr)', gap: 64 }}>
          <div>
            <SectionLabel>The Problem</SectionLabel>
            <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.25 }}>
              Why the existing landscape is insufficient
            </h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
            {problems.map(({ title, body }) => (
              <div key={title} style={{ paddingBottom: 28, borderBottom: '1px solid var(--border-subtle)' }}>
                <h4 style={{ fontSize: 18, fontWeight: 600, color: 'var(--gold)', marginBottom: 10 }}>
                  {title}
                </h4>
                <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function WhatWeAreBuilding() {
  return (
    <section style={SECTION}>
      <div style={CONTAINER}>
        <SectionLabel>What We Are Building</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64, marginTop: 24 }}>
          <div>
            <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 24, lineHeight: 1.25 }}>
              A modular intelligence platform for serious market participants
            </h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 18, lineHeight: 1.75 }}>
              Quantorus365 is being constructed as a multi-engine intelligence platform. Each module handles a distinct domain — signals, risk, macro, derivatives, alpha construction — with each engine informing the decisions of the others.
            </p>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32, lineHeight: 1.75 }}>
              The Intelligence Engine — the core module — is the first to reach a functional state. It integrates market data, factor scoring, scenario detection, portfolio fit analysis, and an 11-gate rejection discipline into a single coherent decision layer.
            </p>
            <Link href="/dashboard" style={btn('outline')}>
              Platform Architecture
            </Link>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {[
              { title: 'Engine-Led',      body: 'Every capability is built as a discrete, composable intelligence module.' },
              { title: 'Rejection-First', body: 'Fewer, better signals. Aggressive quality gates before any output.' },
              { title: 'Portfolio-Aware', body: 'No signal exists in isolation — context of the full book is always present.' },
              { title: 'Explainable',     body: 'Every decision surfaces its reasoning — confidence components, rejection codes, factor scores.' },
            ].map(({ title, body }) => (
              <div key={title} style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 6, padding: 22, position: 'relative' }}>
                <div style={{ width: 6, height: 6, background: 'var(--gold)', borderRadius: '50%', marginBottom: 14 }} />
                <h4 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
                  {title}
                </h4>
                <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function EngineCard({ engine }: { engine: (typeof ENGINES)[0] }) {
  const isActive = engine.status === 'active';
  const Wrapper  = isActive ? Link : 'div';
  const props    = isActive ? { href: '/login' } : {};

  return (
    <Wrapper
      {...(props as any)}
      style={{
        display:        'block',
        background:     isActive ? 'rgba(201,168,76,0.04)' : 'var(--surface-2)',
        border:         `1px solid ${isActive ? 'rgba(201,168,76,0.25)' : 'var(--border-subtle)'}`,
        borderRadius:   4,
        padding:        28,
        cursor:         isActive ? 'pointer' : 'default',
        transition:     'all 0.25s ease',
        textDecoration: 'none',
        opacity:        isActive ? 1 : 0.7,
        position:       'relative',
        overflow:       'hidden',
        color:          'inherit',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 1, color: isActive ? 'var(--gold)' : 'var(--text-muted)' }}>
          {engine.codename}
        </span>
        <span style={pill(isActive, isActive)}>
          {engine.statusLabel}
        </span>
      </div>

      <h4 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
        {engine.name}
      </h4>

      <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
        {engine.purpose}
      </p>

      {isActive && (
        <div style={{ marginTop: 18, color: 'var(--gold)', fontSize: 12, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
          Access Engine →
        </div>
      )}
    </Wrapper>
  );
}

function EngineArchitecture() {
  const topEngines = ENGINES.slice(0, 3);
  const botEngines = ENGINES.slice(3);

  return (
    <section style={{ ...SECTION, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={CONTAINER}>
        <SectionLabel>Platform Architecture</SectionLabel>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 40 }}>
          <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)' }}>
            A deliberate multi-engine intelligence system
          </h2>
          <Link href="/dashboard" style={btn('ghost')}>
            All Engines →
          </Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          {topEngines.map(engine => <EngineCard key={engine.id} engine={engine} />)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(botEngines.length, 1)}, 1fr)`, gap: 16 }}>
          {botEngines.map(engine => <EngineCard key={engine.id} engine={engine} />)}
        </div>
      </div>
    </section>
  );
}

function PlatformMaturity() {
  const phases = [
    { phase: 'Phase I',  label: 'Intelligence Engine',     desc: 'Core signal generation, rejection engine, scenario detection, portfolio fit scoring.', status: 'active'  },
    { phase: 'Phase II', label: 'Risk Intelligence',       desc: 'Portfolio VaR, dynamic sizing, drawdown management, correlation monitoring.',          status: 'next'    },
    { phase: 'Phase III',label: 'Macro & Flow',            desc: 'Macro regime detection, institutional flow analysis, earnings cycle integration.',     status: 'roadmap' },
    { phase: 'Phase IV', label: 'Derivatives Intelligence',desc: 'Options OI analysis, PCR dynamics, volatility surface, max pain calculation.',         status: 'roadmap' },
    { phase: 'Phase V',  label: 'Alpha Construction',      desc: 'Systematic factor research, alpha construction, portfolio optimisation engine.',       status: 'roadmap' },
  ];

  return (
    <section style={{ ...SECTION, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={CONTAINER}>
        <SectionLabel>Build Progress</SectionLabel>
        <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 32 }}>
          Deliberate, phased development
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {phases.map(({ phase, label, desc, status }) => {
            const dotColor = status === 'active' ? 'var(--gold)' : status === 'next' ? 'var(--navy-400)' : 'var(--gray-700)';
            return (
              <div key={phase} style={{ display: 'grid', gridTemplateColumns: '32px 120px 1fr', gap: 16, alignItems: 'flex-start' }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: dotColor, marginTop: 6, boxShadow: status === 'active' ? '0 0 12px rgba(201,168,76,0.5)' : 'none' }} />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', letterSpacing: 1 }}>
                  {phase}
                </span>
                <div>
                  <h4 style={{ fontSize: 16, fontWeight: 600, color: status === 'active' ? 'var(--text-primary)' : 'var(--gray-400)', marginBottom: 4 }}>
                    {label}
                  </h4>
                  <p style={{ color: status === 'active' ? 'var(--text-secondary)' : 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>
                    {desc}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function InsightsStrip() {
  return (
    <section style={{ ...SECTION, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={CONTAINER}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 32 }}>
          <div>
            <SectionLabel>Insights</SectionLabel>
            <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)' }}>
              Platform thinking and market intelligence
            </h2>
          </div>
          <Link href="/dashboard" style={btn('ghost')}>All Insights →</Link>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {INSIGHTS.slice(0, 2).map((insight: any) => (
            <Link key={insight.slug} href={`/dashboard`} style={{ display: 'block', padding: 28, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 4, textDecoration: 'none', color: 'inherit' }}>
              <div style={{ fontSize: 11, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 }}>
                {insight.category}
              </div>
              <h4 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 }}>
                {insight.title}
              </h4>
              <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6, marginBottom: 16 }}>{insight.excerpt}</p>
              <div style={{ display: 'flex', gap: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                <span>{insight.date}</span><span>·</span><span>{insight.readTime}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function ContactStrip() {
  return (
    <section style={{ ...SECTION, borderTop: '1px solid var(--border-subtle)' }}>
      <div style={CONTAINER}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 64 }}>
          <div>
            <SectionLabel>Early Conversations</SectionLabel>
            <h2 style={{ fontSize: 'clamp(1.6rem, 2.5vw, 2.2rem)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 18 }}>
              We are speaking with serious participants early
            </h2>
            <p style={{ color: 'var(--text-secondary)', lineHeight: 1.75, marginBottom: 28 }}>
              If you are an institution, fund, or professional market participant with an interest in the platform — or if you are a strategic partner exploring alignment — we welcome structured conversations at this stage of development.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Link href="/login" style={btn('primary')}>Begin a Conversation</Link>
              <Link href="/dashboard" style={btn('outline')}>Platform Overview</Link>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {[
              { label: 'Strategic Partnership', desc: 'Explore integration, co-development, or distribution alignment.' },
              { label: 'Institutional Access',  desc: 'Early access to the Intelligence Engine for professional evaluation.' },
              { label: 'Platform Inquiry',      desc: 'Questions about architecture, development roadmap, or capability direction.' },
            ].map(({ label, desc }) => (
              <div key={label} style={{ display: 'flex', gap: 14, padding: 18, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 4 }}>
                <div style={{ width: 6, height: 6, background: 'var(--gold)', borderRadius: '50%', marginTop: 8, flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{label}</div>
                  <p style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.6 }}>{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function HomePage() {
  return (
    <div style={SHELL}>
      <Nav />
      <main>
        <Hero />
        <ProblemSection />
        <WhatWeAreBuilding />
        <EngineArchitecture />
        <PlatformMaturity />
        <InsightsStrip />
        <ContactStrip />
      </main>
      <Footer />
    </div>
  );
}
