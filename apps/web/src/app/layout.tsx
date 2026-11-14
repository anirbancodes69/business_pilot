import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'BusinessPilot' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
