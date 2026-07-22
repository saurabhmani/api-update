import type { Metadata } from 'next';
import { AuthProvider } from '@/hooks/useAuth';
import { QueryProvider } from '@/providers/QueryProvider';
import '@/styles/globals.scss';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Quantorus365 — India Stock Intelligence',
  description: 'Institutional-grade equity analytics, signal intelligence, rankings, and portfolio tools',
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
