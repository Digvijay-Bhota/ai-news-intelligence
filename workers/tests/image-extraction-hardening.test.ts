/**
 * Phase 1.1 hardening: <source> handling, tracking pixels, size ordering,
 * input caps, fragments, and credit normalization/clamping.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_CREDIT_LENGTH,
  normalizeImageCredit,
  validateArticleImageUrl,
} from '../src/utils/image-policy';
import {
  MAX_ARTICLE_RAW_CONTENT_LENGTH,
  MIN_IMAGE_DIMENSION,
  extractArticleImage,
} from '../src/utils/image-extraction';

const policy = { allowedHosts: ['platform.theverge.com'] } as const;
const host = 'https://platform.theverge.com';
const html = (body: string) => `<item><content:encoded><![CDATA[${body}]]></content:encoded></item>`;

describe('<source> elements', () => {
  it('never treats an untyped <source> inside <video> as an image', () => {
    const xml = html(`<video><source src="${host}/clip.mp4"></video><img src="${host}/photo.jpg">`);
    expect(extractArticleImage(xml, policy)?.url).toBe(`${host}/photo.jpg`);
    expect(extractArticleImage(html(`<video><source src="${host}/clip.mp4"></video>`), policy)).toBeNull();
  });

  it('rejects a video <source> whose URL ends in .jpg but declares a non-image type', () => {
    expect(extractArticleImage(html(`<video><source src="${host}/still.jpg" type="video/mp4"></video>`), policy)).toBeNull();
  });

  it('accepts <source> with an allowed image type, and untyped <source> inside <picture>', () => {
    expect(extractArticleImage(html(`<picture><source srcset="${host}/a.webp 1200w" type="image/webp"><img src="${host}/a.jpg"></picture>`), policy))
      .toMatchObject({ url: `${host}/a.webp`, source: 'html-content' });
    expect(extractArticleImage(html(`<picture><source srcset="${host}/b.jpg 800w"><img src="${host}/fallback.jpg"></picture>`), policy)?.url)
      .toBe(`${host}/b.jpg`);
  });

  it('rejects an untyped <source> outside <picture>', () => {
    expect(extractArticleImage(html(`<source src="${host}/a.jpg">`), policy)).toBeNull();
    expect(extractArticleImage(html(`<picture></picture><source src="${host}/a.jpg">`), policy)).toBeNull();
  });
});

describe('tracking pixels and declared sizes', () => {
  it(`ignores declared sizes below ${MIN_IMAGE_DIMENSION}px, including 1x1 and 0x0 pixels`, () => {
    for (const pixel of ['width="1" height="1"', 'width="0" height="0"', 'width="1px" height="1px"', 'width="31" height="600"']) {
      expect(extractArticleImage(html(`<img src="${host}/pixel.gif" ${pixel}><img src="${host}/photo.jpg">`), policy)?.url)
        .toBe(`${host}/photo.jpg`);
    }
    expect(extractArticleImage(html(`<img src="${host}/icon.png" width="32" height="32">`), policy)?.url)
      .toBe(`${host}/icon.png`);
  });

  it('skips a tiny Media RSS thumbnail and falls back to the next source type', () => {
    const xml = `<item><media:thumbnail url="${host}/t.jpg" width="1" height="1"/><enclosure url="${host}/e.jpg" type="image/jpeg"/></item>`;
    expect(extractArticleImage(xml, policy)).toMatchObject({ url: `${host}/e.jpg`, source: 'rss-enclosure' });
  });

  it('does not let a tracking pixel make an item-level credit ambiguous', () => {
    const xml = `<item><media:credit>Photo Desk</media:credit><description><![CDATA[
      <img src="${host}/pixel.gif" width="1" height="1"><img src="${host}/photo.jpg">]]></description></item>`;
    expect(extractArticleImage(xml, policy)).toMatchObject({ url: `${host}/photo.jpg`, credit: 'Photo Desk' });
  });
});

describe('candidate ordering', () => {
  const media = (name: string, size?: number, h = host) =>
    `<media:content url="${h}/${name}.jpg" medium="image"${size ? ` width="${size}" height="${size}"` : ''}/>`;

  it('keeps an unknown-size image in its feed position instead of ranking it last', () => {
    expect(extractArticleImage(html(`<img src="${host}/hero.jpg"><img src="${host}/inline.jpg" width="1200" height="800">`), policy)?.url)
      .toBe(`${host}/hero.jpg`);
  });

  it('sorts known sizes largest-first within their own positions', () => {
    const xml = `<item>${media('small', 400)}${media('unknown')}${media('large', 1600)}</item>`;
    expect(extractArticleImage(xml, policy)?.url).toBe(`${host}/large.jpg`);

    // Order is [large, unknown, small]: when large fails validation, unknown is next.
    const largeBlocked = `<item>${media('small', 400)}${media('unknown')}${media('large', 1600, 'https://images.other.example')}</item>`;
    expect(extractArticleImage(largeBlocked, policy)?.url).toBe(`${host}/unknown.jpg`);
  });

  it('is deterministic for the same input', () => {
    const xml = `<item>${media('a', 400)}${media('b')}${media('c', 400)}${media('d')}</item>`;
    const first = extractArticleImage(xml, policy);
    expect(first?.url).toBe(`${host}/a.jpg`);
    for (let i = 0; i < 5; i++) expect(extractArticleImage(xml, policy)).toEqual(first);
  });
});

describe('input size and malformed content', () => {
  const imageEntry = (padTo: number) => {
    const start = `<item><enclosure url="${host}/a.jpg" type="image/jpeg"/><description>`;
    const end = '</description></item>';
    return start + 'x'.repeat(padTo - start.length - end.length) + end;
  };

  it(`parses entries up to ${MAX_ARTICLE_RAW_CONTENT_LENGTH} characters and rejects longer ones without truncating`, () => {
    expect(extractArticleImage(imageEntry(MAX_ARTICLE_RAW_CONTENT_LENGTH), policy)?.url).toBe(`${host}/a.jpg`);
    expect(extractArticleImage(imageEntry(MAX_ARTICLE_RAW_CONTENT_LENGTH + 1), policy)).toBeNull();
  });

  it('returns null for unterminated CDATA or comments', () => {
    expect(extractArticleImage(`<item><enclosure url="${host}/a.jpg" type="image/jpeg"/><description><![CDATA[ open</description></item>`, policy)).toBeNull();
    expect(extractArticleImage(`<item><!-- <enclosure url="${host}/old.jpg" type="image/jpeg"/></item>`, policy)).toBeNull();
  });

  it('handles hostile content near the cap quickly', () => {
    const fill = (unit: string) => `<item>${unit.repeat(Math.floor((MAX_ARTICLE_RAW_CONTENT_LENGTH - 13) / unit.length))}</item>`;
    for (const hostile of [
      fill('<![CDATA[ x '),
      fill('<!-- x '),
      fill('<description> text '),
      fill('<media:credit> c '),
      `<item><x a="${'<b c=1>'.repeat(4000)}</item>`.slice(0, MAX_ARTICLE_RAW_CONTENT_LENGTH),
    ]) {
      const started = Date.now();
      expect(extractArticleImage(hostile, policy)).toBeNull();
      // Generous sanity bound only; growth with input size is checked below.
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });

  it('extracts an image that appears at the very end of a just-under-cap entry', () => {
    const start = '<item><content:encoded><![CDATA[';
    const end = `<img src="${host}/late.jpg" width="1200" height="675">]]></content:encoded></item>`;
    const xml = start + '<p>text</p>'.repeat(Math.floor((MAX_ARTICLE_RAW_CONTENT_LENGTH - start.length - end.length) / 11)) + end;
    expect(xml.length).toBeLessThanOrEqual(MAX_ARTICLE_RAW_CONTENT_LENGTH);
    expect(xml.length).toBeGreaterThan(MAX_ARTICLE_RAW_CONTENT_LENGTH - 11);
    expect(extractArticleImage(xml, policy)?.url).toBe(`${host}/late.jpg`);
  });

  it('strips many comments and skips many CDATA sections correctly', () => {
    const tail = `<enclosure url="${host}/a.jpg" type="image/jpeg"/>`;
    const many = (unit: string, extra = '') =>
      `<item>${unit.repeat(Math.floor((MAX_ARTICLE_RAW_CONTENT_LENGTH - 40 - tail.length - extra.length) / unit.length))}${tail}${extra}</item>`;
    expect(extractArticleImage(many('<!--x-->'), policy)?.url).toBe(`${host}/a.jpg`);
    expect(extractArticleImage(many('<![CDATA[x]]>', '<!-- end -->'), policy)?.url).toBe(`${host}/a.jpg`);
    // Comment-like text inside CDATA is content, not a comment.
    expect(extractArticleImage(`<item><description><![CDATA[<!-- note --><img src="${host}/in-cdata.jpg">]]></description></item>`, policy)?.url)
      .toBe(`${host}/in-cdata.jpg`);
  });

  it('keeps parsing cost roughly linear in entry size for hostile shapes', async () => {
    // Date.now() advances during synchronous work in the Workers test pool;
    // performance.now() does not reliably, so it is not used here.
    const timePerCall = async (xml: string): Promise<number> => {
      for (let iterations = 1; ; iterations *= 2) {
        await new Promise(resolve => setTimeout(resolve, 0)); // keep the test runner responsive
        const started = Date.now();
        for (let i = 0; i < iterations; i++) extractArticleImage(xml, policy);
        const elapsed = Date.now() - started;
        if (elapsed >= 20 || iterations >= 4096) return elapsed / iterations;
      }
    };
    const median3 = async (xml: string) =>
      [await timePerCall(xml), await timePerCall(xml), await timePerCall(xml)].sort((a, b) => a - b)[1];
    const fill = (unit: string, size: number) => `<item>${unit.repeat(Math.floor((size - 13) / unit.length))}</item>`;
    for (const unit of ['<!--x-->', '<![CDATA[x]]><!--y-->', '<description> text ', '<media:credit> c ', '<media:group></media:content>']) {
      const small = await median3(fill(unit, MAX_ARTICLE_RAW_CONTENT_LENGTH / 4));
      const large = await median3(fill(unit, MAX_ARTICLE_RAW_CONTENT_LENGTH));
      // 4x the input: about 4x the time when linear, about 16x when quadratic.
      expect(large / Math.max(small, 1e-3), unit).toBeLessThan(8);
    }
  }, 30_000);
});

describe('URL fragments', () => {
  it('drops fragments from accepted URLs', () => {
    expect(validateArticleImageUrl(`${host}/a.jpg#section`, policy, 'image/jpeg')).toBe(`${host}/a.jpg`);
    expect(validateArticleImageUrl(`${host}/a.jpg#`, policy, 'image/jpeg')).toBe(`${host}/a.jpg`);
    expect(extractArticleImage(`<item><enclosure url="${host}/a.jpg?w=1#x" type="image/jpeg"/></item>`, policy)?.url)
      .toBe(`${host}/a.jpg?w=1`);
  });

  it('still rejects disallowed hosts hidden behind a fragment', () => {
    expect(validateArticleImageUrl(`https://images.other.example/a.jpg#${host}`, policy, 'image/jpeg')).toBeNull();
  });
});

describe('credit normalization and clamping', () => {
  it(`keeps credits up to ${MAX_IMAGE_CREDIT_LENGTH} code points unchanged`, () => {
    const exact = 'A'.repeat(MAX_IMAGE_CREDIT_LENGTH);
    expect(normalizeImageCredit(exact)).toBe(exact);
  });

  it('clamps longer credits to 199 code points plus an ellipsis', () => {
    const clamped = normalizeImageCredit('A'.repeat(250));
    expect(clamped).toBe(`${'A'.repeat(MAX_IMAGE_CREDIT_LENGTH - 1)}…`);
    expect(Array.from(clamped!)).toHaveLength(MAX_IMAGE_CREDIT_LENGTH);
    expect(normalizeImageCredit(`${'A'.repeat(198)} ${'B'.repeat(10)}`)).toBe(`${'A'.repeat(198)}…`);
  });

  it('never splits a multi-unit character when clamping', () => {
    const clamped = normalizeImageCredit('📷'.repeat(250))!;
    expect(Array.from(clamped)).toHaveLength(MAX_IMAGE_CREDIT_LENGTH);
    expect(clamped).toBe(`${'📷'.repeat(MAX_IMAGE_CREDIT_LENGTH - 1)}…`);
  });

  it('keeps escaped bracket text and collapses control characters and whitespace', () => {
    expect(normalizeImageCredit('Photo <AP> Wire')).toBe('Photo <AP> Wire');
    expect(normalizeImageCredit('  Photo\u0000Desk\n\tAgency  ')).toBe('Photo Desk Agency');
    expect(normalizeImageCredit('   ')).toBeNull();
    expect(normalizeImageCredit(null)).toBeNull();
  });

  it('applies the same rules to extracted credits', () => {
    const credit = (inner: string) => extractArticleImage(
      `<item><media:credit>${inner}</media:credit><media:content url="${host}/a.jpg" medium="image"/></item>`, policy,
    )?.credit;
    expect(credit('Photo &lt;AP&gt; Wire')).toBe('Photo <AP> Wire');
    expect(credit('C'.repeat(300))).toBe(`${'C'.repeat(MAX_IMAGE_CREDIT_LENGTH - 1)}…`);
  });
});
