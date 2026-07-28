import type { Metadata } from 'next';
import { AuthProvider } from '@/hooks/useAuth';
import { QueryProvider } from '@/providers/QueryProvider';
import '@/styles/globals.scss';
import './corporate.css';
import './hero-revert.css';
import './careers.css';
import './responsive.css';
import './contact-form.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { default: 'Quantorus — Intelligence engineered for meaningful progress', template: '%s | Quantorus' },
  description: 'Quantorus combines strategy, software, data, cloud, and AI to turn complex business challenges into measurable progress.',
  metadataBase: new URL('https://quantorus.example'),
  openGraph: { type: 'website', siteName: 'Quantorus', title: 'Quantorus', description: 'Intelligence engineered for meaningful progress.', images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Quantorus — Intelligence engineered for meaningful progress.' }] },
  twitter: { card: 'summary_large_image', title: 'Quantorus', description: 'Intelligence engineered for meaningful progress.', images: ['/og.png'] },
  robots: { index: true, follow: true },
   icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
