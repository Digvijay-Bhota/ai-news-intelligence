'use client';

import React, { useState } from 'react';

/**
 * Story visual: renders a real image when a URL is supplied and falls back to a
 * typographic, topic-tinted panel when the image is missing or fails to load.
 * The fallback is decorative (aria-hidden) and never depicts story content.
 */

const PALETTES = [
  'from-indigo-950 via-indigo-800 to-blue-700',
  'from-slate-950 via-slate-800 to-cyan-800',
  'from-emerald-950 via-emerald-900 to-teal-700',
  'from-violet-950 via-violet-900 to-fuchsia-800',
  'from-stone-950 via-stone-800 to-amber-800',
  'from-sky-950 via-blue-900 to-sky-700',
];

function paletteFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTES[h % PALETTES.length];
}

interface StoryVisualProps {
  /** Seed for the fallback palette; the topic keeps related stories consistent. */
  seed: string;
  label?: string | null;
  src?: string | null;
  alt?: string;
  /** Lead image loads eagerly; all others are lazy. */
  priority?: boolean;
  className?: string;
}

export function StoryVisual({ seed, label, src, alt = '', priority = false, className = '' }: StoryVisualProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = !!src && failedSrc !== src;

  if (showImage) {
    return (
      <div className={`relative overflow-hidden bg-divider ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary external URLs; next/image is not configured for them */}
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailedSrc(src)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      data-testid="story-visual-fallback"
      className={`relative overflow-hidden bg-gradient-to-br ${paletteFor(label || seed)} ${className}`}
    >
      <div className="absolute inset-0 opacity-25 bg-[radial-gradient(circle_at_1px_1px,rgba(255,255,255,0.55)_1px,transparent_0)] bg-[length:18px_18px]" />
      <div className="absolute -right-10 -bottom-16 h-48 w-48 rounded-full border border-white/15" />
      <div className="absolute -right-2 -bottom-8 h-28 w-28 rounded-full border border-white/20" />
      {label && (
        <span className="absolute left-4 bottom-4 right-4 font-serif text-lg sm:text-xl font-bold leading-tight text-white/90 line-clamp-2">
          {label}
        </span>
      )}
    </div>
  );
}
