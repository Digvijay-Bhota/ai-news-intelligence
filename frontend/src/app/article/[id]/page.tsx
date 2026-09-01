import React from 'react';
import Link from 'next/link';
import { env } from 'cloudflare:workers';
import { generateHmac } from '../../../utils/hmac';

export const runtime = 'edge';

async function getArticle(id: string) {
  const secret = env.HMAC_SECRET;
  if (!secret) throw new Error('Missing HMAC_SECRET');
  
  const backend = env.BACKEND_API;
  if (!backend || typeof backend.fetch !== 'function') throw new Error('Missing BACKEND_API binding');

  const ts = Math.floor(Date.now() / 1000);
  const nonce = `nonce-${ts}-${Math.random().toString(36).substring(2, 9)}`;
  const fullPath = `/api/v1/articles/${id}`;

  const hmacPayload = {
    method: 'GET',
    path: fullPath,
    timestamp: ts,
    nonce,
    body: '',
  };

  const signature = await generateHmac(hmacPayload, secret);

  const backendReq = new Request(`http://backend${fullPath}`, {
    method: 'GET',
    headers: {
      'X-HMAC-Signature': signature,
      'X-Nonce': nonce,
      'X-Timestamp': String(ts),
    },
  });

  const res = await backend.fetch(backendReq);
  
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error('Failed to fetch article from backend');
  }
  
  const json = await res.json();
  return json.data;
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const article = await getArticle(id);

  if (!article) {
    return (
      <div className="max-w-3xl mx-auto py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900">Article Not Found</h1>
        <p className="mt-2 text-gray-600">The article you're looking for does not exist or has been removed.</p>
        <Link href="/" className="mt-4 inline-block text-indigo-600 hover:text-indigo-800">
          Return to Feed
        </Link>
      </div>
    );
  }

  const { title, source, published_at, summary, cleaned_text, topics, events, extracted_entities, url } = article;
  
  const formattedDate = published_at 
    ? new Date(published_at * 1000).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    : 'Unknown date';

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-8">
        <Link href="/" className="inline-flex items-center text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-indigo-400 rounded transition-colors">
          &larr; Back to Feed
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-8 space-y-8">
          <header className="mb-10 pb-6 border-b border-gray-200 dark:border-gray-800">
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-extrabold text-gray-900 dark:text-gray-50 tracking-tight mb-5 leading-tight">
              {title}
            </h1>
            <div className="flex flex-wrap items-center text-sm text-gray-500 dark:text-gray-400 gap-4">
              <span className="font-semibold text-gray-700 dark:text-gray-300">{source}</span>
              <span>&bull;</span>
              <time dateTime={published_at ? new Date(published_at * 1000).toISOString() : ''}>
                {formattedDate}
              </time>
            </div>
          </header>

          {summary && (
            <section className="bg-gray-50 dark:bg-gray-900/50 p-6 rounded-xl border border-gray-100 dark:border-gray-800">
              <h2 className="text-sm font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-3">Summary</h2>
              <p className="text-lg text-gray-800 dark:text-gray-200 leading-relaxed max-w-prose">
                {summary}
              </p>
            </section>
          )}

          {cleaned_text && (
            <section>
              <h2 className="sr-only">Full Article</h2>
              <div className="max-w-prose text-lg text-gray-800 dark:text-gray-200 whitespace-pre-wrap leading-relaxed">
                {cleaned_text}
              </div>
            </section>
          )}

          <section className="pt-8 pb-4">
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center px-6 py-3.5 border border-transparent text-base font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-indigo-500 dark:focus-visible:ring-offset-gray-950 transition-colors shadow-sm">
              Read original on {source}
            </a>
          </section>
        </div>

        <aside className="space-y-10 lg:col-span-4 lg:border-l lg:border-gray-200 dark:lg:border-gray-800 lg:pl-8">
          {topics && topics.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-4">Topics</h3>
              <div className="flex flex-wrap gap-2">
                {topics.map((t: any) => (
                  <Link key={t.slug} href={`/topics/${t.slug}`} className="inline-flex items-center px-3 py-1.5 rounded-full text-sm font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 transition-colors">
                    {t.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {extracted_entities && extracted_entities.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-4">Key Entities</h3>
              <div className="flex flex-wrap gap-2">
                {extracted_entities.map((e: string, i: number) => (
                  <span key={i} className="inline-flex items-center px-2.5 py-1 rounded-md border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900">
                    {e}
                  </span>
                ))}
              </div>
            </section>
          )}

          {events && events.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 dark:text-gray-400 uppercase mb-5">Event Timeline</h3>
              <div className="space-y-6">
                {events.map((e: any, i: number) => (
                  <div key={i} className="relative pl-5 border-l-2 border-gray-200 dark:border-gray-700">
                    <div className={`absolute -left-[5px] top-1.5 w-2 h-2 rounded-full ${
                      e.severity === 'critical' ? 'bg-red-500' :
                      e.severity === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
                    }`}></div>
                    <h4 className="text-sm font-bold text-gray-900 dark:text-gray-100">{e.title}</h4>
                    {e.started_at && (
                      <time className="text-xs text-gray-500 dark:text-gray-400 block mb-1 mt-0.5">
                        {new Date(e.started_at * 1000).toLocaleDateString()}
                      </time>
                    )}
                    {e.description && (
                      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1.5 leading-relaxed">{e.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
