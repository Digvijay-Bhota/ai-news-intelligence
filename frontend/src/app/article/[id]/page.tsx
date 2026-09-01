import React from 'react';
import { headers } from 'next/headers';
import Link from 'next/link';

async function getArticle(id: string) {
  const headersList = await headers();
  const host = headersList.get('host') || 'localhost:3000';
  const protocol = host.includes('localhost') ? 'http' : 'https';
  
  // Forward cookies for identity
  const cookieHeader = headersList.get('cookie') || '';
  
  const res = await fetch(`${protocol}://${host}/api/articles/${id}`, {
    headers: {
      cookie: cookieHeader
    },
    // No cache here to ensure fresh fetch, though the BFF may cache
    cache: 'no-store'
  });
  
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error('Failed to fetch article');
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
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6 lg:px-8">
      <div className="mb-6">
        <Link href="/" className="text-sm font-medium text-indigo-600 hover:text-indigo-800">
          &larr; Back to Feed
        </Link>
      </div>

      <header className="mb-8 border-b pb-6">
        <h1 className="text-3xl sm:text-4xl font-extrabold text-gray-900 tracking-tight mb-4">
          {title}
        </h1>
        <div className="flex flex-wrap items-center text-sm text-gray-500 gap-4">
          <span className="font-semibold text-gray-700">{source}</span>
          <span>&bull;</span>
          <time dateTime={published_at ? new Date(published_at * 1000).toISOString() : ''}>
            {formattedDate}
          </time>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
        <div className="lg:col-span-2 space-y-8">
          {summary && (
            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">Summary</h2>
              <div className="prose text-gray-700 max-w-none">
                <p className="text-lg leading-relaxed">{summary}</p>
              </div>
            </section>
          )}

          {cleaned_text && (
            <section>
              <h2 className="text-xl font-bold text-gray-900 mb-3">Full Article</h2>
              <div className="prose text-gray-800 max-w-none whitespace-pre-wrap leading-relaxed">
                {cleaned_text}
              </div>
            </section>
          )}

          <section className="pt-6">
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center px-5 py-3 border border-transparent text-base font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 transition-colors">
              Read original on {source}
            </a>
          </section>
        </div>

        <aside className="space-y-8 lg:border-l lg:pl-8">
          {topics && topics.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 uppercase mb-3">Topics</h3>
              <div className="flex flex-wrap gap-2">
                {topics.map((t: any) => (
                  <Link key={t.slug} href={`/topics/${t.slug}`} className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 hover:bg-blue-200 transition-colors">
                    {t.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {extracted_entities && extracted_entities.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 uppercase mb-3">Key Entities</h3>
              <div className="flex flex-wrap gap-2">
                {extracted_entities.map((e: string, i: number) => (
                  <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded border border-gray-300 text-xs font-medium text-gray-700 bg-white">
                    {e}
                  </span>
                ))}
              </div>
            </section>
          )}

          {events && events.length > 0 && (
            <section>
              <h3 className="text-sm font-bold tracking-wider text-gray-500 uppercase mb-4">Event Timeline</h3>
              <div className="space-y-6">
                {events.map((e: any, i: number) => (
                  <div key={i} className="relative pl-4 border-l-2 border-gray-200">
                    <div className={`absolute -left-1.5 top-1.5 w-3 h-3 rounded-full ${
                      e.severity === 'critical' ? 'bg-red-500' :
                      e.severity === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
                    }`}></div>
                    <h4 className="text-sm font-bold text-gray-900">{e.title}</h4>
                    {e.started_at && (
                      <time className="text-xs text-gray-500 block mb-1">
                        {new Date(e.started_at * 1000).toLocaleDateString()}
                      </time>
                    )}
                    {e.description && (
                      <p className="text-sm text-gray-600 mt-1">{e.description}</p>
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
