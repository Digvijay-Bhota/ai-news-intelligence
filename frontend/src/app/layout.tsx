import './globals.css';
import { ReactNode } from 'react';
import { Header } from '../components/Header';
import { UserArticlesProvider } from '../lib/userArticlesContext';

export const metadata = {
  title: 'AI News Intelligence - Professional Feed',
  description: 'AI-curated news intelligence platform for professionals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 dark:bg-gray-950 flex flex-col text-gray-900 dark:text-gray-50 antialiased font-sans">
        <UserArticlesProvider>
          <Header />

          <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
            <main className="w-full">
              {children}
            </main>
          </div>
        </UserArticlesProvider>

        <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 py-8 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center text-sm text-gray-500 dark:text-gray-400">
            <div className="mb-4 sm:mb-0">
              &copy; {new Date().getFullYear()} AI News Intelligence. All rights reserved.
            </div>
            <div className="flex space-x-6">
              <a href="#" className="hover:text-gray-900 transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-gray-900 transition-colors">Terms of Service</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
