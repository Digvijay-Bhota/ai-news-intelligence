'use client';
import React, { useState, useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

export function Header() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileMenuOpen(false);
      }
    };
    if (mobileMenuOpen) {
      document.addEventListener('keydown', handleEscape);
    }
    return () => document.removeEventListener('keydown', handleEscape);
  }, [mobileMenuOpen]);

  const toggleMenu = () => setMobileMenuOpen(!mobileMenuOpen);
  const closeMenu = () => setMobileMenuOpen(false);

  const navLinks = [
    { name: 'Feed', href: '/' },
    { name: 'For You', href: '/foryou' },
    { name: 'Topics', href: '#', disabled: true },
    { name: 'Saved', href: '/saved' },
    { name: 'Settings', href: '/settings' },
  ];

  return (
    <header className="bg-white dark:bg-gray-900 shadow-sm dark:shadow-gray-800/50 sticky top-0 z-20 border-b border-transparent dark:border-gray-800">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center">
          <div className="w-8 h-8 bg-indigo-600 dark:bg-indigo-500 rounded-lg flex items-center justify-center mr-3">
            <svg role="presentation" aria-hidden="true" focusable="false" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <Link href="/" className="text-xl font-bold text-gray-900 dark:text-gray-50 tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded">AI News Intelligence</Link>
        </div>
        <nav className="hidden sm:flex space-x-6">
          {navLinks.map((link) => (
            link.disabled ? (
              <span key={link.name} className="text-gray-400 dark:text-gray-600 font-medium px-1 py-5 cursor-not-allowed">
                {link.name}
              </span>
            ) : (
              <Link
                key={link.name}
                href={link.href}
                className={`font-medium px-1 py-5 border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded-sm ${pathname === link.href ? 'text-indigo-600 dark:text-indigo-400 border-indigo-600 dark:border-indigo-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 border-transparent'}`}
              >
                {link.name}
              </Link>
            )
          ))}
        </nav>
        <div className="sm:hidden flex items-center relative" ref={menuRef}>
          <button
            onClick={toggleMenu}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded-md p-2 transition-colors"
            aria-expanded={mobileMenuOpen}
            aria-label="Toggle navigation menu"
          >
            <svg role="presentation" aria-hidden="true" focusable="false" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {mobileMenuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>

          {mobileMenuOpen && (
            <div className="absolute top-14 right-0 w-48 bg-white dark:bg-gray-900 rounded-md shadow-lg py-1 ring-1 ring-black ring-opacity-5 dark:ring-gray-700 focus:outline-none">
              {navLinks.map((link) => (
                link.disabled ? (
                  <span key={link.name} className="block px-4 py-2 text-sm text-gray-400 dark:text-gray-600 cursor-not-allowed">
                    {link.name}
                  </span>
                ) : (
                  <Link
                    key={link.name}
                    href={link.href}
                    onClick={closeMenu}
                    className={`block px-4 py-2 text-sm ${pathname === link.href ? 'bg-gray-100 dark:bg-gray-800 text-indigo-600 dark:text-indigo-400 font-medium' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
                  >
                    {link.name}
                  </Link>
                )
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
