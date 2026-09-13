'use client';

import React, { useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';

const navLinks: { name: string; href: string }[] = [
  { name: 'Intelligence', href: '/' },
  { name: 'Events', href: '/events' },
  { name: 'For You', href: '/foryou' },
  { name: 'Topics', href: '/topics' },
  { name: 'Saved', href: '/saved' },
  { name: 'Settings', href: '/settings' },
];

export function Header() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 bg-surface border-b border-divider">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Top bar */}
        <div className="flex items-center justify-between h-14">
          {/* Wordmark */}
          <Link
            href="/"
            className="font-serif font-bold text-ink text-xl tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            aria-label="AI News Intelligence — Home"
          >
            Intelligence
          </Link>

          {/* Desktop nav */}
          <nav aria-label="Primary navigation" className="hidden sm:flex items-center gap-6">
            {navLinks.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className={`font-sans text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded ${
                  pathname === link.href
                    ? 'text-ink border-b-2 border-ink pb-0.5'
                    : 'text-slate hover:text-charcoal'
                }`}
                aria-current={pathname === link.href ? 'page' : undefined}
              >
                {link.name}
              </Link>
            ))}
          </nav>

          {/* Mobile hamburger */}
          <button
            className="sm:hidden p-2 text-slate hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-label="Toggle navigation menu"
          >
            <svg role="presentation" aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {menuOpen
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <nav
          aria-label="Mobile navigation"
          className="sm:hidden border-t border-divider bg-surface"
        >
          {navLinks.map(link => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMenuOpen(false)}
              className={`block px-6 py-3 font-sans text-sm font-medium border-l-2 transition-colors focus-visible:outline-none focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-accent ${
                pathname === link.href
                  ? 'border-ink text-ink bg-paper'
                  : 'border-transparent text-slate hover:text-charcoal hover:bg-paper'
              }`}
              aria-current={pathname === link.href ? 'page' : undefined}
            >
              {link.name}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
