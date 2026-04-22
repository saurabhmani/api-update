import type { Metadata } from 'next';
import { AuthProvider } from '@/hooks/useAuth';
import '@/styles/globals.scss';

export const metadata: Metadata = {
  title: 'Quantorus365 — India Stock Intelligence',
  description: 'Institutional-grade equity analytics, signal intelligence, rankings, and portfolio tools',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
