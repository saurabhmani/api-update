'use client';
import { useState } from 'react';
import styles from '@/styles/Contact.module.scss';

export default function ContactPage() {
  const [type, setType]         = useState('platform');
  const [submitted, setSubmitted] = useState(false);

  const inquiryTypes = [
    { id: 'platform',     label: 'Platform Inquiry',        desc: 'Questions about capabilities, architecture, or access.' },
    { id: 'early-access', label: 'Early Access Interest',   desc: 'Interest in evaluating the platform professionally.' },
    { id: 'partnership',  label: 'Strategic Partnership',   desc: 'Explore integration, co-development, or distribution.' },
    { id: 'strategic',    label: 'Strategic Conversation',  desc: 'Broader alignment, investment, or advisory discussion.' },
  ];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  function SectionLabel({ children }: { children: React.ReactNode }) {
    return <span className="section-label">{children}</span>;
  }

  return (
    <>
      <section className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div className={`container ${styles.heroContainer}`}>
          <SectionLabel>Contact</SectionLabel>
          <h1 className={styles.heroHeading}>
            We welcome structured conversations at this stage
          </h1>
          <p className={styles.heroLede}>
            Quantorus365 is in active development. If you are an institution, professional participant, potential partner, or serious prospect — we are engaging now, before the platform reaches full deployment.
          </p>
        </div>
      </section>

      <section className={`section ${styles.formSection}`}>
        <div className="container">
          <div className={styles.formGrid}>

            <div>
              <SectionLabel>Who we are speaking with</SectionLabel>
              <h2 className={styles.contextHeading}>Early conversations shape better products</h2>

              <div className={styles.typesList}>
                {inquiryTypes.map(({ id, label, desc }) => (
                  <div
                    key={id}
                    id={id}
                    onClick={() => setType(id)}
                    style={{
                      padding: '20px 24px',
                      background:   type === id ? 'rgba(201,168,76,0.05)' : 'var(--surface-2)',
                      border:       `1px solid ${type === id ? 'rgba(201,168,76,0.3)' : 'var(--border-subtle)'}`,
                      borderRadius: 4,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    <div className={styles.typeRow}>
                      <div
                        className={styles.typeDot}
                        style={{ background: type === id ? 'var(--gold)' : 'var(--gray-700)' }}
                      />
                      <span
                        className={styles.typeLabel}
                        style={{ color: type === id ? 'var(--text-primary)' : 'var(--gray-400)' }}
                      >
                        {label}
                      </span>
                    </div>
                    <p className={styles.typeDesc}>{desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div>
              {submitted ? (
                <div className={styles.successPanel}>
                  <div className={styles.successIcon}>✦</div>
                  <h3 className={styles.successTitle}>
                    Message received
                  </h3>
                  <p className={styles.successText}>
                    We review all inquiries carefully and respond personally. You can expect a response within 2–3 business days.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className={styles.form}>
                  <div className={styles.formFieldPair}>
                    {[
                      { id: 'name', label: 'Full Name', type: 'text', placeholder: 'Your name' },
                      { id: 'org',  label: 'Organisation', type: 'text', placeholder: 'Your firm or organisation' },
                    ].map(({ id, label, type, placeholder }) => (
                      <div key={id}>
                        <label htmlFor={id} className={styles.label}>
                          {label}
                        </label>
                        <input
                          id={id}
                          type={type}
                          placeholder={placeholder}
                          required
                          className={styles.input}
                        />
                      </div>
                    ))}
                  </div>

                  <div>
                    <label htmlFor="email" className={styles.label}>
                      Email Address
                    </label>
                    <input
                      id="email"
                      type="email"
                      placeholder="your@email.com"
                      required
                      className={styles.inputNoTransition}
                    />
                  </div>

                  <div>
                    <label htmlFor="message" className={styles.label}>
                      Message
                    </label>
                    <textarea
                      id="message"
                      rows={5}
                      placeholder="Describe your interest, organisation context, or the nature of the conversation you have in mind."
                      required
                      className={styles.textarea}
                    />
                  </div>

                  <button type="submit" className={`btn btn--primary ${styles.submitButton}`}>
                    Send Message
                  </button>

                  <p className={styles.formNote}>
                    We respond personally to all inquiries. This form does not subscribe you to anything.
                  </p>
                </form>
              )}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
