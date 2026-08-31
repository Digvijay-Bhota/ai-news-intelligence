import './globals.css';
import { ReactNode } from 'react';
import { Header } from '../components/Header';

export const metadata = {
  title: 'AI News Intelligence - Professional Feed',
  description: 'AI-curated news intelligence platform for professionals.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 flex flex-col text-gray-900 antialiased font-sans">
        <Header />

        <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8">
          <main className="w-full">
            {children}
          </main>
        </div>

        <footer className="bg-white border-t border-gray-200 py-8 mt-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row justify-between items-center text-sm text-gray-500">
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
