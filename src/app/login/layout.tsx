import { Suspense } from 'react';

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<main style={{ minHeight: '100vh' }} />}>{children}</Suspense>;
}
