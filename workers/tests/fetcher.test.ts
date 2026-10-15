import { describe, it, expect, vi } from 'vitest';
import { fetchAndIngest } from '../src/tasks/fetcher';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import type { Source } from '../src/types';

describe('fetchAndIngest', () => {
  it('fetches and persists RSS articles', async () => {
    const env = createMockEnv();
    const source: Source = {
      id: 1,
      name: 'Test Source',
      feed_url: 'http://example.com/rss',
      base_url: 'http://example.com',
      source_type: 'rss',
      reliability_score: 1.0,
      fetch_interval_minutes: 60,
      active: 1,
      last_fetched_at: null,
      created_at: 0,
      updated_at: 0,
    };

    const rssXml = `
      <rss version="2.0">
        <channel>
          <item>
            <title>Test Title</title>
            <link>http://example.com/article1</link>
            <description>Test Summary</description>
            <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
          </item>
        </channel>
      </rss>
    `;

    // Mock global fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(rssXml),
    });

    // Mock DbClient
    const mockDbClient = {
      getArticleByExternalId: vi.fn().mockResolvedValue(null),
      createArticle: vi.fn().mockResolvedValue({ id: 1 }),
      getDedupHash: vi.fn().mockResolvedValue(null),
      createDedupHash: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    const { inserted: ingested } = await fetchAndIngest(env, source);
    expect(ingested).toBe(1);
    expect(global.fetch).toHaveBeenCalledWith('http://example.com/rss');
    expect(mockDbClient.createArticle).toHaveBeenCalled();
  });
});

import { parseRss } from '../src/tasks/fetcher';

describe('parseRss', () => {
  it('parses RSS 2.0 with missing description and malformed date', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>RSS Title</title>
          <link>http://rss.com/1</link>
          <pubDate>Invalid Date String</pubDate>
          <guid>guid1</guid>
        </item>
      </channel></rss>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].external_id).toBe('guid1');
    expect(res[0].title).toBe('RSS Title');
    expect(res[0].url).toBe('http://rss.com/1');
    expect(res[0].summary).toBeNull();
    expect(res[0].published_at).toBeNull();
  });

  it('parses Atom feed with href links', () => {
    const xml = `
      <feed>
        <entry>
          <title>Atom Title</title>
          <link href="http://atom.com/1" rel="alternate"/>
          <summary>Atom Summary</summary>
          <updated>2024-01-01T00:00:00Z</updated>
          <id>atom-id-1</id>
        </entry>
      </feed>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].external_id).toBe('atom-id-1');
    expect(res[0].title).toBe('Atom Title');
    expect(res[0].url).toBe('http://atom.com/1');
    expect(res[0].summary).toBe('Atom Summary');
    expect(res[0].published_at).toBe(1704067200);
  });

  it('deduplicates duplicate IDs in the same feed payload', () => {
    const xml = `
      <feed>
        <entry>
          <title>Title 1</title>
          <link href="http://dup.com/1"/>
          <id>duplicate-id</id>
        </entry>
        <entry>
          <title>Title 2</title>
          <link href="http://dup.com/2"/>
          <id>duplicate-id</id>
        </entry>
      </feed>
    `;
    const res = parseRss(xml);
    expect(res).toHaveLength(1);
    expect(res[0].title).toBe('Title 1');
  });
});

const rssItem = (inner: string) => `<rss><channel><item>${inner}</item></channel></rss>`;
const atomEntry = (inner: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>${inner}</entry></feed>`;
const LINK = '<link>https://news.example.test/a</link>';

describe('parseRss XML text decoding', () => {
  it('decodes RSS title, summary and guid entities exactly once', () => {
    const [a] = parseRss(rssItem(`<title>AT&amp;T &lt;rocks&gt; &quot;q&quot; &apos;a&apos;</title>${LINK}`
      + '<description>R&amp;D &amp;amp; more</description><guid>id?a=1&amp;b=2</guid>'));
    expect(a.title).toBe(`AT&T <rocks> "q" 'a'`);
    expect(a.summary).toBe('R&D &amp; more');
    expect(a.external_id).toBe('id?a=1&b=2');
  });

  it('decodes Atom title and summary entities', () => {
    const [a] = parseRss(atomEntry('<title type="text">Q&amp;A: models</title><link href="https://news.example.test/a"/>'
      + '<summary type="html">&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;</summary><id>urn:a</id>'));
    expect(a.title).toBe('Q&A: models');
    expect(a.summary).toBe('<p>Fish &amp; chips</p>');
  });

  it('decodes the numeric entities the shared decoder supports and preserves others', () => {
    const [a] = parseRss(rssItem(`<title>Caf&#233; &#xE9; &#x1F600; &#x110000; &nbsp; &bogus;</title>${LINK}`));
    expect(a.title).toBe('Café é 😀 &#x110000; &nbsp; &bogus;');
  });

  it('decodes double-encoded entities by one level only', () => {
    const [a] = parseRss(rssItem(`<title>&amp;amp; &amp;lt;b&amp;gt; &amp;#233;</title>${LINK}`));
    expect(a.title).toBe('&amp; &lt;b&gt; &#233;');
  });

  it('keeps CDATA literal, including multi-line and mixed with escaped text', () => {
    const [a] = parseRss(rssItem(`<title>A &amp; <![CDATA[B &amp; <b>C</b>]]></title>${LINK}`
      + '<description><![CDATA[<p>Line 1\nLine &amp; 2</p>]]></description>'));
    expect(a.title).toBe('A & B &amp; <b>C</b>');
    expect(a.summary).toBe('<p>Line 1\nLine &amp; 2</p>');
    const [multi] = parseRss(rssItem(`<title><![CDATA[Multi\nline title]]></title>${LINK}`));
    expect(multi.title).toBe('Multi\nline title');
  });

  it('gives escaped HTML and its CDATA form the same summary', () => {
    const [escaped] = parseRss(rssItem(`<title>T</title>${LINK}<description>&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;</description>`));
    const [cdata] = parseRss(rssItem(`<title>T</title>${LINK}<description><![CDATA[<p>Fish &amp; chips</p>]]></description>`));
    expect(escaped.summary).toBe('<p>Fish &amp; chips</p>');
    expect(cdata.summary).toBe(escaped.summary);
  });

  it('keeps Atom xhtml content as markup instead of decoding it', () => {
    const xhtml = '<div xmlns="http://www.w3.org/1999/xhtml"><p>A &amp; B &lt; C</p></div>';
    const [a] = parseRss(atomEntry(`<title>T</title><link href="https://news.example.test/a"/><summary type="xhtml">${xhtml}</summary>`));
    expect(a.summary).toBe(xhtml);
  });

  it('handles malformed text without throwing', () => {
    const [a] = parseRss(rssItem(`<title>AT&T &amp T &#xZZ; <![CDATA[open</title>${LINK}`));
    expect(a.title).toBe('AT&T &amp T &#xZZ; <![CDATA[open');
    const [empty] = parseRss(rssItem(`<title>T</title>${LINK}<description><![CDATA[ ]]></description>`));
    expect(empty.summary).toBeNull();
    // An unterminated CDATA section runs to the next "]]>", hiding the link inside it.
    expect(parseRss(rssItem(`<title><![CDATA[open</title>${LINK}<description><![CDATA[x]]></description>`))).toEqual([]);
    expect(parseRss(rssItem(`<title><![CDATA[ ]]></title>${LINK}`))).toEqual([]);
  });

  it('uses the decoded link as external_id for RSS items without a guid', () => {
    const [a] = parseRss(rssItem('<title>T</title><link>https://news.example.test/s?id=1&amp;src=rss</link>'));
    expect(a.external_id).toBe('https://news.example.test/s?id=1&src=rss');
    expect(a.url).toBe('https://news.example.test/s?id=1&src=rss');
  });
});

describe('parseRss article links', () => {
  const urlOf = (links: string) => parseRss(atomEntry(`<title>T</title>${links}<id>urn:t</id>`))[0]?.url ?? null;

  it('never selects enclosure or self links that appear before the alternate link', () => {
    expect(urlOf('<link rel="enclosure" type="image/jpeg" href="https://img.example.test/a.jpg"/>'
      + '<link rel="self" href="https://news.example.test/feed"/><link rel="alternate" href="https://news.example.test/a"/>'))
      .toBe('https://news.example.test/a');
  });

  it('prefers rel="alternate" over a link without rel, then document order', () => {
    expect(urlOf('<link href="https://news.example.test/no-rel"/><link rel="Alternate" href="https://news.example.test/alt-1"/>'
      + '<link rel="alternate" href="https://news.example.test/alt-2"/>')).toBe('https://news.example.test/alt-1');
    expect(urlOf('<link rel="http://www.iana.org/assignments/relation/alternate" href="https://news.example.test/iri"/>'))
      .toBe('https://news.example.test/iri');
  });

  it('falls back to the first valid link without rel', () => {
    expect(urlOf('<link rel="self" href="https://news.example.test/feed"/><link href="/relative"/>'
      + '<link href="https://news.example.test/a"/><link href="https://news.example.test/b"/>')).toBe('https://news.example.test/a');
  });

  it('skips entries with no usable article link', () => {
    expect(urlOf('<link rel="enclosure" href="https://img.example.test/a.jpg"/><link rel="self" href="https://news.example.test/f"/>'
      + '<link rel="related" href="https://news.example.test/r"/>')).toBeNull();
    expect(urlOf('')).toBeNull();
    for (const bad of ['/relative', 'javascript:alert(1)', 'ftp://news.example.test/a', 'http:/news.example.test/a', 'https://', 'mailto:a@b.test']) {
      expect(urlOf(`<link rel="alternate" href="${bad}"/>`)).toBeNull();
      expect(parseRss(rssItem(`<title>T</title><link>${bad}</link>`))).toEqual([]);
    }
  });

  it('skips an invalid alternate in favor of the next valid one', () => {
    expect(urlOf('<link rel="alternate" href="javascript:void(0)"/><link rel="alternate" href="https://news.example.test/a"/>'))
      .toBe('https://news.example.test/a');
  });

  it('decodes href and RSS link text once and unwraps CDATA links', () => {
    expect(urlOf('<link rel="alternate" href="https://news.example.test/a?x=1&amp;y=2"/>')).toBe('https://news.example.test/a?x=1&y=2');
    const [a] = parseRss(rssItem('<title>T</title><link><![CDATA[https://news.example.test/c?x=1&y=2]]></link>'));
    expect(a.url).toBe('https://news.example.test/c?x=1&y=2');
  });

  it('ignores <link> tags inside CDATA HTML content', () => {
    const [a] = parseRss(rssItem('<title>T</title><description><![CDATA[<link rel="stylesheet" href="https://cdn.example.test/s.css">]]></description>'
      + '<link>https://news.example.test/a</link>'));
    expect(a.url).toBe('https://news.example.test/a');
  });

  it('keeps an image enclosure as image metadata only, not the article URL', () => {
    const [a] = parseRss(rssItem('<title>T</title><enclosure url="https://img.example.test/a.jpg" type="image/jpeg"/>' + LINK));
    expect(a.url).toBe('https://news.example.test/a');
    expect(a.raw_content).toContain('<enclosure url="https://img.example.test/a.jpg"');
  });
});

describe('parseRss legacy identity', () => {
  it('is absent for entries the previous parser already read correctly', () => {
    const [a] = parseRss(rssItem(`<title>Plain title</title>${LINK}<guid>g1</guid><description>Plain &amp; summary</description>`));
    expect(a).toMatchObject({ external_id: 'g1', title: 'Plain title', url: 'https://news.example.test/a' });
    expect(a.legacy).toBeUndefined();
  });

  it('records the encoded identity the previous parser stored', () => {
    const [rss] = parseRss(rssItem('<title>A &amp; B</title><link>https://news.example.test/s?id=1&amp;src=rss</link>'));
    expect(rss.legacy).toEqual({
      external_id: 'https://news.example.test/s?id=1&amp;src=rss',
      title: 'A &amp; B',
      url: 'https://news.example.test/s?id=1&amp;src=rss',
    });
    const [atom] = parseRss(atomEntry('<title>T</title><link rel="enclosure" href="https://img.example.test/a.jpg"/>'
      + '<link rel="alternate" href="https://news.example.test/a"/><id>urn:t</id>'));
    expect(atom.url).toBe('https://news.example.test/a');
    expect(atom.legacy).toEqual({ external_id: 'urn:t', title: 'T', url: 'https://img.example.test/a.jpg' });
  });
});

describe('fetchAndIngest legacy identity lookups', () => {
  const source = { id: 1, name: 'Test Source', feed_url: 'http://example.com/rss' } as Source;

  function mockDb(existingExternalIds: string[] = []) {
    const db = {
      getArticleByExternalId: vi.fn(async (id: string) => (existingExternalIds.includes(id) ? { id: 9 } : null)),
      createArticle: vi.fn().mockResolvedValue({ id: 1 }),
      getDedupHash: vi.fn().mockResolvedValue(null),
      createDedupHash: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
    return db;
  }

  function serve(xml: string) {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(xml) });
  }

  it('makes no extra lookups for entity-free items', async () => {
    serve(rssItem(`<title>Plain</title>${LINK}<guid>g1</guid>`));
    const db = mockDb();
    expect((await fetchAndIngest(createMockEnv(), source)).inserted).toBe(1);
    expect(db.getDedupHash).toHaveBeenCalledTimes(1);
    expect(db.getArticleByExternalId).toHaveBeenCalledTimes(1);
  });

  it('skips an item whose encoded external_id is already stored', async () => {
    serve(rssItem('<title>A &amp; B</title><link>https://news.example.test/s?id=1&amp;src=rss</link>'));
    const db = mockDb(['https://news.example.test/s?id=1&amp;src=rss']);
    expect((await fetchAndIngest(createMockEnv(), source)).inserted).toBe(0);
    expect(db.getArticleByExternalId).toHaveBeenNthCalledWith(1, 'https://news.example.test/s?id=1&src=rss');
    expect(db.createArticle).not.toHaveBeenCalled();
  });
});
