import './globals.css';
import { ReactNode } from 'react';

export const metadata = {
  title: 'AI News Intelligence',
  description: 'AI News Application',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 flex flex-col">
        <header className="bg-white shadow-sm sticky top-0 z-10">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <h1 className="text-xl font-bold text-gray-900">AI News Intelligence</h1>
            <nav className="hidden sm:flex space-x-4">
              <a href="#" className="text-gray-500 hover:text-gray-900">Home</a>
              <a href="#" className="text-gray-500 hover:text-gray-900">Topics</a>
              <a href="#" className="text-gray-500 hover:text-gray-900">Saved</a>
            </nav>
            {/* Mobile menu placeholder */}
            <div className="sm:hidden text-gray-500">Menu</div>
          </div>
        </header>

        <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 flex flex-col sm:flex-row gap-8">
          {/* Sidebar placeholder */}
          <aside className="w-full sm:w-64 shrink-0 hidden sm:block">
            <div className="bg-white rounded-lg shadow p-4">
              <h2 className="font-semibold text-gray-700 mb-2">Filters</h2>
              <p className="text-sm text-gray-500">Sidebar navigation coming soon.</p>
            </div>
          </aside>

          <main className="flex-1">
            {children}
          </main>
        </div>

        <footer className="bg-white border-t py-6 mt-auto">
          <div className="max-w-7xl mx-auto px-4 text-center text-sm text-gray-400">
            &copy; 2026 AI News Intelligence
          </div>
        </footer>
      </body>
    </html>
  );
}
