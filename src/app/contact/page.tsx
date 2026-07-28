import SiteShell from '@/components/corporate/SiteShell';
import ContactForm from '@/components/corporate/ContactForm';
import { PageHero, Section, CTA } from '@/components/corporate/PageParts';
import { brand } from '@/content/corporate';

export const metadata = {
  title: 'Contact',
  description: 'Start a conversation with Quantorus about your technology priorities.',
  alternates: { canonical: '/contact' },
  openGraph: {
    title: 'Contact',
    description: 'Start a conversation with Quantorus about your technology priorities.',
    url: 'https://quantorus.ai/contact',
    siteName: 'Quantorus',
  },
};

export default function Contact() {
  return (
    <SiteShell>
      <PageHero
        eyebrow="Contact"
        title="Let’s make the next move clearer."
        body="Tell us what you’re trying to change, improve, or build. We’ll start with a considered conversation."
        crumbs={[{ label: 'Contact' }]}
      />
      <Section>
        <div className="q-detail-grid">
          <div>
            <p className="q-eyebrow">Start a conversation</p>
            <h2>Useful context is a great first step.</h2>
            <p className="q-body">
              Share a little about your goals and constraints. We’ll review your note and follow up by
              email.
            </p>
            <p style={{ marginTop: 24 }}>
              <a className="q-link" href={`mailto:${brand.contactEmail}`}>
                {brand.contactEmail}
              </a>
            </p>
            <h2>Office and map</h2>
            <p className="q-body">Office location and map details are pending confirmation.</p>
            <h2>Questions</h2>
            <details>
              <summary>What happens after I submit?</summary>
              <p>
                Your message is delivered to our team by email. We’ll reply from a Quantorus address as
                soon as we can review the context you shared.
              </p>
            </details>
          </div>
          <ContactForm />
        </div>
      </Section>
      <CTA />
    </SiteShell>
  );
}
