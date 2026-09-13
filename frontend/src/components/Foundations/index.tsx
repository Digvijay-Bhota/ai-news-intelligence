import React from 'react';

export function Kicker({ children, type = 'default' }: { children: React.ReactNode, type?: 'default' | 'developing' | 'breaking' | 'positive' | 'accent' }) {
  const colorMap = {
    default: 'text-slate',
    developing: 'text-developing',
    breaking: 'text-breaking',
    positive: 'text-positive',
    accent: 'text-accent'
  };
  return (
    <div className={`font-sans text-[11px] font-bold tracking-widest uppercase mb-1.5 ${colorMap[type]}`}>
      {children}
    </div>
  );
}

export function Divider({ className = '' }: { className?: string }) {
  return <hr className={`border-t border-divider w-full ${className}`} />;
}

export function EditorialHeading({ children, level = 2, className = '' }: { children: React.ReactNode, level?: 1 | 2 | 3 | 4, className?: string }) {
  const sizes: Record<1|2|3|4, string> = {
    1: 'text-4xl sm:text-5xl lg:text-6xl font-serif font-bold leading-[1.1] text-ink',
    2: 'text-2xl sm:text-3xl font-serif font-bold leading-[1.2] text-ink',
    3: 'text-xl sm:text-2xl font-serif font-bold leading-[1.25] text-charcoal',
    4: 'text-lg font-serif font-bold leading-snug text-charcoal',
  };
  const cls = `${sizes[level]} ${className}`;
  if (level === 1) return <h1 className={cls}>{children}</h1>;
  if (level === 2) return <h2 className={cls}>{children}</h2>;
  if (level === 3) return <h3 className={cls}>{children}</h3>;
  return <h4 className={cls}>{children}</h4>;
}

export function SectionLabel({ children, className = '' }: { children: React.ReactNode, className?: string }) {
  return (
    <h2 className={`font-sans text-xs font-bold tracking-widest uppercase text-ink border-b-2 border-ink pb-2 mb-4 ${className}`}>
      {children}
    </h2>
  );
}

export function Metadata({ children, className = '' }: { children: React.ReactNode, className?: string }) {
  return (
    <div className={`font-sans text-xs text-slate flex items-center gap-2 flex-wrap ${className}`}>
      {children}
    </div>
  );
}

export function Surface({ children, className = '' }: { children: React.ReactNode, className?: string }) {
  return (
    <div className={`bg-surface p-4 sm:p-6 border border-divider ${className}`}>
      {children}
    </div>
  );
}
