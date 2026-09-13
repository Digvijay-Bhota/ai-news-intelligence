import React from 'react';

export function SourceChip({ name, url, className = '' }: { name: string, url?: string, className?: string }) {
  // Use a generic favicon service or just text if no url
  let host = '';
  try {
    if (url) {
      host = new URL(url).hostname;
    }
  } catch(e) {}
  
  const faviconUrl = host ? `https://www.google.com/s2/favicons?domain=${host}&sz=32` : null;

  return (
    <span className={`inline-flex items-center gap-1.5 font-sans text-[11px] font-bold uppercase tracking-wider text-charcoal bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-sm border border-gray-200 dark:border-gray-700 ${className}`}>
      {faviconUrl && (
        <img src={faviconUrl} alt="" className="w-3.5 h-3.5 object-contain rounded-sm mix-blend-multiply dark:mix-blend-normal" loading="lazy" />
      )}
      {name}
    </span>
  );
}
