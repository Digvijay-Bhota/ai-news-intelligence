'use client';
import React from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

export function Header() {
  const pathname = usePathname();

  return (
    <header className="bg-white shadow-sm sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center mr-3">
            <svg aria-hidden="true" focusable="false" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <Link href="/" className="text-xl font-bold text-gray-900 tracking-tight">AI News Intelligence</Link>
        </div>
        <nav className="hidden sm:flex space-x-6">
          <Link href="/" className={`font-medium px-1 py-5 border-b-2 transition-colors ${pathname === '/' ? 'text-indigo-600 border-indigo-600' : 'text-gray-500 hover:text-gray-900 border-transparent'}`}>Feed</Link>
          <a href="#" className="text-gray-400 font-medium px-1 py-5 cursor-not-allowed">Topics</a>
          <Link href="/saved" className={`font-medium px-1 py-5 border-b-2 transition-colors ${pathname === '/saved' ? 'text-indigo-600 border-indigo-600' : 'text-gray-500 hover:text-gray-900 border-transparent'}`}>Saved</Link>
        </nav>
        <div className="sm:hidden flex items-center">
          <button className="text-gray-500 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded-md p-2">
            <svg aria-hidden="true" focusable="false" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
