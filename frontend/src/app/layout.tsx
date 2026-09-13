import './globals.css';
import { ReactNode } from 'react';
import { Header } from '../components/Header';
import { UserArticlesProvider } from '../lib/userArticlesContext';
import { FollowsProvider } from '../lib/followsContext';
import { Inter, Lora } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const lora = Lora({ subsets: ['latin'], variable: '--font-serif', display: 'swap' });

export const metadata = {
  title: 'AI News Intelligence - Professional Feed',
  description: 'AI-curated news intelligence platform for professionals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable}`}>
      <body className="min-h-screen bg-paper dark:bg-ink flex flex-col text-charcoal dark:text-gray-100 antialiased font-sans selection:bg-accent/20">
        <UserArticlesProvider>
          <FollowsProvider>
            <Header />

            <div className="flex-1 w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 max-w-7xl">
              <main className="w-full">
                {children}
              </main>
            </div>
          </FollowsProvider>
        </UserArticlesProvider>

        <footer className="border-t border-divider py-12 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center text-sm text-muted">
            <div className="mb-4 sm:mb-0 font-sans tracking-wide uppercase text-xs font-semibold">
              &copy; {new Date().getFullYear()} Intelligence Platform
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
