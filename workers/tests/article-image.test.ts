import { describe, expect, it, vi } from 'vitest';
import { extractArticleImageFields, sanitizeArticleImageFields } from '../src/utils/article-image';
import { MAX_ARTICLE_RAW_CONTENT_LENGTH } from '../src/utils/image-extraction';

const VERGE_IMAGE = 'https://platform.theverge.com/uploads/photo.jpg';
const NULLS = { image_url: null, image_credit: null };
const mediaItem = (url = VERGE_IMAGE, credit = '<media:credit>Verge Photo Desk</media:credit>') =>
  `<item><title>t</title><media:content url="${url}" medium="image" width="1600" height="900">${credit}</media:content></item>`;

describe('extractArticleImageFields (ingestion)', () => {
  it('returns a validated image and its structurally tied credit for The Verge', () => {
    expect(extractArticleImageFields(mediaItem(), 'The Verge')).toEqual({
      image_url: VERGE_IMAGE,
      image_credit: 'Verge Photo Desk',
    });
  });

  it('returns nulls for TechCrunch and unknown sources even with a Verge-hosted URL', () => {
    for (const source of ['TechCrunch', 'Ars Technica', 'Unknown', 'the verge', null, undefined]) {
      expect(extractArticleImageFields(mediaItem(), source)).toEqual(NULLS);
    }
  });

  it('returns nulls for missing, empty, malformed or image-free content', () => {
    for (const raw of [null, undefined, '', '   ', '<item><title>No image</title></item>',
      `<item><description><![CDATA[<img src="${VERGE_IMAGE}">`, // unterminated CDATA
      mediaItem('https://cdn.platform.theverge.com/a.jpg'), // unapproved subdomain
      mediaItem('http://platform.theverge.com/a.jpg'),
    ]) {
      expect(extractArticleImageFields(raw, 'The Verge')).toEqual(NULLS);
    }
  });

  it('returns nulls for oversized content without invoking the extractor', () => {
    const extract = vi.fn();
    const oversized = mediaItem() + ' '.repeat(MAX_ARTICLE_RAW_CONTENT_LENGTH);
    expect(extractArticleImageFields(oversized, 'The Verge', { extract })).toEqual(NULLS);
    expect(extract).not.toHaveBeenCalled();
  });

  it('never throws: extractor or host-lookup failures yield nulls', () => {
    const extract = () => { throw new Error('boom'); };
    expect(extractArticleImageFields(mediaItem(), 'The Verge', { extract })).toEqual(NULLS);
    const hostsFor = () => { throw new Error('boom'); };
    expect(extractArticleImageFields(mediaItem(), 'The Verge', { hostsFor })).toEqual(NULLS);
  });

  it('keeps the URL but drops a credit that belongs to a different image', () => {
    const xml = `<item>
      <media:content url="${VERGE_IMAGE}" medium="image" width="1600" height="900"/>
      <media:content url="https://platform.theverge.com/small.jpg" medium="image" width="400" height="225"><media:credit>Small Agency</media:credit></media:content>
    </item>`;
    expect(extractArticleImageFields(xml, 'The Verge')).toEqual({ image_url: VERGE_IMAGE, image_credit: null });
  });
});

describe('sanitizeArticleImageFields (API responses)', () => {
  const item = { id: 7, title: 'Story', source: 'The Verge', topics: ['AI'], events: [], url: 'https://www.theverge.com/s' };

  it('returns a valid stored URL with its credit and preserves every other field', () => {
    const result = sanitizeArticleImageFields({ ...item, image_url: VERGE_IMAGE, image_credit: 'Desk' });
    expect(result).toEqual({ ...item, image_url: VERGE_IMAGE, image_credit: 'Desk' });
  });

  it('nulls both fields when the host is revoked for the source', () => {
    const revoked = () => [] as readonly string[];
    expect(sanitizeArticleImageFields({ ...item, image_url: VERGE_IMAGE, image_credit: 'Desk' }, revoked))
      .toEqual({ ...item, ...NULLS });
  });

  it('does not return a host approved for The Verge on a TechCrunch article', () => {
    expect(sanitizeArticleImageFields({ ...item, source: 'TechCrunch', image_url: VERGE_IMAGE, image_credit: 'Desk' }))
      .toEqual({ ...item, source: 'TechCrunch', ...NULLS });
  });

  it.each([
    ['HTTP', 'http://platform.theverge.com/a.jpg'],
    ['malformed', 'not a url'],
    ['relative', '/uploads/a.jpg'],
    ['credentialed', 'https://user:pass@platform.theverge.com/a.jpg'],
    ['disallowed port', 'https://platform.theverge.com:8443/a.jpg'],
    ['SVG', 'https://platform.theverge.com/a.svg'],
    ['malformed percent escape', 'https://platform.theverge.com/a%ZZ.jpg'],
    ['oversized', `https://platform.theverge.com/${'a'.repeat(3000)}.jpg`],
    ['javascript scheme', 'javascript:alert(1)'],
    ['unapproved subdomain', 'https://cdn.platform.theverge.com/a.jpg'],
  ])('removes a stored %s URL and its credit', (_label, url) => {
    expect(sanitizeArticleImageFields({ ...item, image_url: url, image_credit: 'Desk' })).toEqual({ ...item, ...NULLS });
  });

  it('adds null fields to old objects that lack image keys or hold non-string values', () => {
    expect(sanitizeArticleImageFields(item)).toEqual({ ...item, ...NULLS });
    expect(sanitizeArticleImageFields({ ...item, image_url: 42, image_credit: { x: 1 } })).toEqual({ ...item, ...NULLS });
  });

  it('drops a credit without a URL and clamps an overlong stored credit', () => {
    expect(sanitizeArticleImageFields({ ...item, image_url: null, image_credit: 'Desk' })).toEqual({ ...item, ...NULLS });
    const result = sanitizeArticleImageFields({ ...item, image_url: VERGE_IMAGE, image_credit: 'C'.repeat(500) });
    expect(Array.from(result.image_credit!)).toHaveLength(200);
  });

  it('strips URL fragments and does not mutate its input', () => {
    const input = { ...item, image_url: `${VERGE_IMAGE}#top`, image_credit: 'Desk' };
    const copy = structuredClone(input);
    expect(sanitizeArticleImageFields(input).image_url).toBe(VERGE_IMAGE);
    expect(input).toEqual(copy);
  });
});
