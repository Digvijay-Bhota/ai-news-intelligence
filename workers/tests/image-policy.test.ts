import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, validateArticleImageUrl } from '../src/utils/image-policy';
import { extractArticleImage } from '../src/utils/image-extraction';

const policy = { allowedHosts: ['platform.theverge.com'] } as const;

describe('validateArticleImageUrl', () => {
  it('normalizes an allowlisted HTTPS raster image URL', () => {
    expect(validateArticleImageUrl(
      'https://PLATFORM.theverge.com/wp-content/story.jpg?width=1200&quality=85',
      policy,
      'image/jpeg; charset=binary',
    )).toBe('https://platform.theverge.com/wp-content/story.jpg?width=1200&quality=85');
  });

  it('does not entity-decode its input (extraction decodes each feed layer once)', () => {
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg?w=1&amp;q=85', policy, 'image/jpeg'))
      .toBe('https://platform.theverge.com/a.jpg?w=1&amp;q=85');
  });

  it('allows only the exact approved host', () => {
    expect(validateArticleImageUrl('https://platform.theverge.com/photo.webp', policy, 'image/webp'))
      .toBe('https://platform.theverge.com/photo.webp');
    for (const url of [
      'https://cdn.platform.theverge.com/photo.webp', // unlisted subdomain
      'https://theverge.com/photo.webp', // parent domain
      'https://platform.theverge.com.evil.example/photo.webp', // suffix lookalike
      'https://evilplatform.theverge.com/photo.webp', // prefix lookalike
    ]) {
      expect(validateArticleImageUrl(url, policy, 'image/webp')).toBeNull();
    }
  });

  it('rejects wildcard allow-list entries so they cannot broaden the policy', () => {
    const wildcardOnly = (entry: string) => ({ allowedHosts: [entry] });
    expect(validateArticleImageUrl('https://cdn.platform.theverge.com/a.jpg', wildcardOnly('*.platform.theverge.com'), 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg', wildcardOnly('*.platform.theverge.com'), 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg', wildcardOnly('*.theverge.com'), 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://evil.co.uk/a.jpg', wildcardOnly('*.co.uk'), 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://evil.com/a.jpg', wildcardOnly('*.com'), 'image/jpeg')).toBeNull();

    // A wildcard next to an exact entry is ignored; the exact entry still works alone.
    const mixed = { allowedHosts: ['platform.theverge.com', '*.platform.theverge.com'] };
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg', mixed, 'image/jpeg'))
      .toBe('https://platform.theverge.com/a.jpg');
    expect(validateArticleImageUrl('https://cdn.platform.theverge.com/a.jpg', mixed, 'image/jpeg')).toBeNull();
  });

  it('rejects trailing-dot hostnames in URLs and allow-list entries', () => {
    expect(validateArticleImageUrl('https://platform.theverge.com./a.jpg', policy, 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg', { allowedHosts: ['platform.theverge.com.'] }, 'image/jpeg'))
      .toBeNull();
  });

  it('accepts image/jpg as a JPEG alias without accepting other unsupported types', () => {
    const url = 'https://platform.theverge.com/a.jpg';
    expect(validateArticleImageUrl(url, policy, 'image/jpg')).toBe(url);
    expect(validateArticleImageUrl(url, policy, 'IMAGE/JPG; charset=binary')).toBe(url);
    for (const mimeType of ['image/pjpeg', 'image/x-jpeg', 'image/jpe', 'image/tiff', 'image/heic', 'image/svg+xml']) {
      expect(validateArticleImageUrl(url, policy, mimeType)).toBeNull();
    }
  });

  it.each([
    ['HTTP', 'http://platform.theverge.com/photo.jpg', 'image/jpeg'],
    ['JavaScript URL', 'javascript:alert(1)', null],
    ['data URL', 'data:image/png;base64,AAAA', 'image/png'],
    ['credentials', 'https://user:pass@platform.theverge.com/photo.jpg', 'image/jpeg'],
    ['empty credentials marker', 'https://@platform.theverge.com/photo.jpg', 'image/jpeg'],
    ['non-default port', 'https://platform.theverge.com:8443/photo.jpg', 'image/jpeg'],
    ['SVG extension', 'https://platform.theverge.com/photo.svg', null],
    ['SVG MIME', 'https://platform.theverge.com/photo.jpg', 'image/svg+xml'],
    ['encoded SVG extension', 'https://platform.theverge.com/photo%2Esvg', null],
    ['unsupported image MIME', 'https://platform.theverge.com/photo.bmp', 'image/bmp'],
    ['non-image MIME', 'https://platform.theverge.com/photo.jpg', 'text/html'],
    ['disallowed host', 'https://images.other.example/photo.jpg', 'image/jpeg'],
    ['relative URL', '/photo.jpg', 'image/jpeg'],
    ['URL with embedded whitespace', 'https://platform.theverge.com/photo name.jpg', 'image/jpeg'],
  ])('rejects %s', (_label, url, mimeType) => {
    expect(validateArticleImageUrl(url, policy, mimeType)).toBeNull();
  });

  it('rejects credentials hidden in URL authority syntax', () => {
    expect(validateArticleImageUrl(
      'https://platform.theverge.com@images.other.example/photo.jpg',
      policy,
      'image/jpeg',
    )).toBeNull();
  });

  it('rejects URLs longer than the configured limit and empty host allow-lists', () => {
    expect(validateArticleImageUrl(`https://platform.theverge.com/${'a'.repeat(30)}.jpg`, {
      ...policy,
      maxUrlLength: 32,
    }, 'image/jpeg')).toBeNull();
    expect(validateArticleImageUrl('https://platform.theverge.com/photo.jpg', { allowedHosts: [] }, 'image/jpeg'))
      .toBeNull();
  });

  it('rejects malformed percent escapes in the path', () => {
    expect(validateArticleImageUrl('https://platform.theverge.com/photo%ZZ.jpg', policy, 'image/jpeg'))
      .toBeNull();
  });

  it('applies the length limit to the normalized URL, not only the input', () => {
    // 2,000 input characters; percent-encoding each "é" makes the output ~6,000.
    const url = `https://platform.theverge.com/${'é'.repeat(1960)}.jpg`;
    expect(url.length).toBeLessThanOrEqual(2048);
    expect(validateArticleImageUrl(url, policy, 'image/jpeg')).toBeNull();
  });

  it.each([
    ['backslash authority', 'https://platform.theverge.com\\@images.other.example/a.jpg'],
    ['fragment before @', 'https://images.other.example#@platform.theverge.com/a.jpg'],
    ['query before @', 'https://images.other.example?@platform.theverge.com/a.jpg'],
    ['encoded dot in host', 'https://platform.theverge.com%2eevil.example/a.jpg'],
    ['literal entity text in host', 'https://platform.theverge.com&#64;images.other.example/a.jpg'],
    ['IPv4 host', 'https://127.0.0.1/a.jpg'],
    ['shorthand IPv4 host', 'https://0x7f.1/a.jpg'],
    ['IPv6 host', 'https://[::1]/a.jpg'],
    ['protocol-relative URL', '//platform.theverge.com/a.jpg'],
  ])('rejects host bypass attempt: %s', (_label, url) => {
    expect(validateArticleImageUrl(url, policy, 'image/jpeg')).toBeNull();
  });

  it('accepts the default HTTPS port and normalizes it away', () => {
    expect(validateArticleImageUrl('https://platform.theverge.com:443/a.jpg', policy, 'image/jpeg'))
      .toBe('https://platform.theverge.com/a.jpg');
  });

  it('ignores unsafe or malformed allow-list entries instead of widening them', () => {
    const url = 'https://platform.theverge.com/a.jpg';
    for (const entry of ['*', '*.com', 'platform.theverge.com:443', 'https://platform.theverge.com']) {
      expect(validateArticleImageUrl(url, { allowedHosts: [entry] }, 'image/jpeg')).toBeNull();
    }
  });
});

describe('decodeXmlEntities', () => {
  it('decodes XML named and numeric entities', () => {
    expect(decodeXmlEntities('a&amp;b &quot;x&quot; &#47; &#x2F; &apos;y&apos;'))
      .toBe('a&b "x" / / \'y\'');
  });

  it('preserves unknown entities and invalid code points', () => {
    expect(decodeXmlEntities('&unknown; &#x110000;')).toBe('&unknown; &#x110000;');
  });
});

describe('extractArticleImage', () => {
  it('extracts an image from The Verge-style content:encoded CDATA and decodes its query', () => {
    const xml = `
      <item>
        <title>Story</title>
        <content:encoded><![CDATA[
          <figure><img src="https://platform.theverge.com/wp-content/uploads/story.jpg?width=1200&amp;quality=85" alt="Story image"></figure>
        ]]></content:encoded>
      </item>
    `;

    expect(extractArticleImage(xml, policy)).toEqual({
      url: 'https://platform.theverge.com/wp-content/uploads/story.jpg?width=1200&quality=85',
      source: 'html-content',
      credit: null,
    });
  });

  it('prefers the largest valid Media RSS content image', () => {
    const xml = `
      <item>
        <media:thumbnail url="https://platform.theverge.com/thumb.jpg" width="160" height="90" />
        <media:content url="https://platform.theverge.com/small.jpg" medium="image" type="image/jpeg" width="400" height="225" />
        <media:content url="https://platform.theverge.com/large.webp" medium="image" type="image/webp" width="1200" height="675" />
      </item>
    `;

    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/large.webp',
      source: 'media-content',
    });
  });

  it('skips invalid higher-priority candidates and falls back to a valid image', () => {
    const xml = `
      <item>
        <media:content url="https://unapproved.example/large.jpg" medium="image" type="image/jpeg" width="1600" height="900" />
        <media:content url="http://platform.theverge.com/small.jpg" medium="image" type="image/jpeg" width="400" height="225" />
        <description><![CDATA[<img src="https://platform.theverge.com/fallback.jpg" />]]></description>
      </item>
    `;

    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/fallback.jpg',
      source: 'html-content',
    });
  });

  it('supports a Media RSS thumbnail when no content image is present', () => {
    const xml = '<item><media:thumbnail url="https://platform.theverge.com/thumb.jpg" /></item>';
    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/thumb.jpg',
      source: 'media-thumbnail',
    });
  });

  it('supports RSS enclosures only when the declared MIME type is an image', () => {
    const xml = `
      <item>
        <enclosure url="https://platform.theverge.com/download.jpg" type="application/octet-stream" />
        <enclosure url="https://platform.theverge.com/article.jpg" type="image/jpeg" length="12345" />
      </item>
    `;
    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/article.jpg',
      source: 'rss-enclosure',
    });
  });

  it('supports Atom rel=enclosure with an image MIME type', () => {
    const xml = `
      <entry>
        <link rel="alternate" href="https://news.example/article" type="text/html" />
        <link rel="enclosure" href="https://platform.theverge.com/article.avif" type="image/avif" />
      </entry>
    `;
    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/article.avif',
      source: 'atom-enclosure',
    });
  });

  it('supports lazy-loaded HTML image attributes and picks the first available URL', () => {
    const xml = `
      <item><description><![CDATA[
        <img src="" data-src="https://platform.theverge.com/lazy.png" alt="Lazy image" />
      ]]></description></item>
    `;
    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/lazy.png',
      source: 'html-content',
    });
  });

  it('prefers lazy-load attributes over an HTTPS placeholder src', () => {
    const xml = `<item><description><![CDATA[
      <img src="https://platform.theverge.com/spacer.gif" data-src="https://platform.theverge.com/real.jpg" />
      ]]></description></item>`;
    expect(extractArticleImage(xml, policy)?.url).toBe('https://platform.theverge.com/real.jpg');

    const lazySrcset = `<item><description><![CDATA[
      <img src="https://platform.theverge.com/spacer.gif" data-srcset="https://platform.theverge.com/real-800.jpg 800w" />
      ]]></description></item>`;
    expect(extractArticleImage(lazySrcset, policy)?.url).toBe('https://platform.theverge.com/real-800.jpg');
  });

  it('picks the largest srcset candidate by width or density', () => {
    const byWidth = `<item><description><![CDATA[
      <img srcset="https://platform.theverge.com/s.jpg 320w, https://platform.theverge.com/l.jpg 1600w, https://platform.theverge.com/m.jpg 800w" />
      ]]></description></item>`;
    expect(extractArticleImage(byWidth, policy)?.url).toBe('https://platform.theverge.com/l.jpg');

    const byDensity = `<item><description><![CDATA[
      <img srcset="https://platform.theverge.com/1x.jpg, https://platform.theverge.com/2x.jpg 2x" />
      ]]></description></item>`;
    expect(extractArticleImage(byDensity, policy)?.url).toBe('https://platform.theverge.com/2x.jpg');
  });

  it('keeps commas inside srcset URLs', () => {
    const xml = `<item><description><![CDATA[
      <img srcset="https://platform.theverge.com/c_fill,w_320/a.jpg 320w, https://platform.theverge.com/c_fill,w_1600/a.jpg 1600w" />
      ]]></description></item>`;
    expect(extractArticleImage(xml, policy)?.url).toBe('https://platform.theverge.com/c_fill,w_1600/a.jpg');
  });

  it('falls back to the next srcset candidate when the largest is not allowed', () => {
    const xml = `<item><description><![CDATA[
      <img srcset="https://platform.theverge.com/m.jpg 800w, https://images.other.example/l.jpg 1600w" />
      ]]></description></item>`;
    expect(extractArticleImage(xml, policy)?.url).toBe('https://platform.theverge.com/m.jpg');
  });

  it('ignores image markup inside XML comments', () => {
    const xml = `<item>
      <!-- <media:content url="https://platform.theverge.com/old.jpg" medium="image" /> -->
      <media:thumbnail url="https://platform.theverge.com/current.jpg" />
    </item>`;
    expect(extractArticleImage(xml, policy)).toMatchObject({
      url: 'https://platform.theverge.com/current.jpg',
      source: 'media-thumbnail',
    });
  });

  it('returns only explicit image-credit metadata and never turns bylines into image credits', () => {
    const withCredit = `
      <item>
        <creator>Staff Writer</creator>
        <media:credit role="photographer">Photo Desk / Example Agency</media:credit>
        <description><![CDATA[<img src="https://platform.theverge.com/photo.jpg" />]]></description>
      </item>
    `;
    expect(extractArticleImage(withCredit, policy)?.credit).toBe('Photo Desk / Example Agency');

    const bylineOnly = `
      <item><creator>Staff Writer</creator>
        <description><![CDATA[<img src="https://platform.theverge.com/photo.jpg" />]]></description>
      </item>
    `;
    expect(extractArticleImage(bylineOnly, policy)?.credit).toBeNull();
  });

  it('returns null for entries without a usable image or without a source-specific allow-list', () => {
    expect(extractArticleImage('<item><title>No image</title></item>', policy)).toBeNull();
    expect(extractArticleImage(
      '<item><description><![CDATA[<img src="https://platform.theverge.com/photo.jpg" />]]></description></item>',
      { allowedHosts: [] },
    )).toBeNull();
  });

  it('extracts image/jpg enclosures', () => {
    const xml = '<item><enclosure url="https://platform.theverge.com/a.jpg" type="image/jpg" /></item>';
    expect(extractArticleImage(xml, policy)).toMatchObject({ url: 'https://platform.theverge.com/a.jpg', source: 'rss-enclosure' });
  });
});

describe('extractArticleImage entity decoding', () => {
  const htmlIn = (body: string) => `<item><description>${body}</description></item>`;

  it('decodes an XML attribute exactly once, so &amp;amp; stays a literal &amp;', () => {
    const xml = '<item><enclosure url="https://platform.theverge.com/a.jpg?q=1&amp;amp;r=2" type="image/jpeg" /></item>';
    expect(extractArticleImage(xml, policy)?.url).toBe('https://platform.theverge.com/a.jpg?q=1&amp;r=2');
  });

  it('decodes escaped (non-CDATA) HTML once per layer: XML text, then the HTML attribute', () => {
    const xml = htmlIn('&lt;img src="https://platform.theverge.com/a.jpg?w=1&amp;amp;h=2"&gt;');
    expect(extractArticleImage(xml, policy)?.url).toBe('https://platform.theverge.com/a.jpg?w=1&h=2');
  });

  it('does not decode CDATA HTML as XML, so escaped markup in CDATA is text, not an image', () => {
    expect(extractArticleImage(htmlIn('<![CDATA[Example: &lt;img src="https://platform.theverge.com/code.jpg"&gt;]]>'), policy))
      .toBeNull();
    expect(extractArticleImage(htmlIn('<![CDATA[<img src="https://platform.theverge.com/a.jpg?w=1&amp;amp;h=2">]]>'), policy)?.url)
      .toBe('https://platform.theverge.com/a.jpg?w=1&amp;h=2');
  });

  it('treats Atom type="text" content as text and type="xhtml" as markup decoded once', () => {
    expect(extractArticleImage(
      '<entry><content type="text">&lt;img src="https://platform.theverge.com/a.jpg"&gt;</content></entry>', policy,
    )).toBeNull();
    expect(extractArticleImage(
      '<entry><content type="xhtml"><div><img src="https://platform.theverge.com/a.jpg?w=1&amp;h=2"/></div></content></entry>', policy,
    )?.url).toBe('https://platform.theverge.com/a.jpg?w=1&h=2');
  });

  it('still applies every URL check after decoding', () => {
    for (const url of [
      'https://platform.theverge.com&#64;images.other.example/a.jpg', // decodes to credentials syntax
      'http&#58;//platform.theverge.com/a.jpg', // decodes to http:
      'https://platform.theverge.com/a&#32;b.jpg', // decodes to whitespace
      'https://platform.theverge.com:8443/a.jpg',
      'https://platform.theverge.com/a&#46;svg', // decodes to .svg
    ]) {
      expect(extractArticleImage(`<item><enclosure url="${url}" type="image/jpeg" /></item>`, policy)).toBeNull();
    }
  });
});

describe('extractArticleImage credit association', () => {
  const media = (name: string, size: number, inner = '') =>
    `<media:content url="https://platform.theverge.com/${name}.jpg" medium="image" width="${size}" height="${size}">${inner}</media:content>`;

  it('uses each media:content element\'s own nested credit, in either document order', () => {
    const large = media('large', 1600, '<media:credit>Large Photo Agency</media:credit>');
    const small = media('small', 400, '<media:credit>Small Photo Agency</media:credit>');
    for (const xml of [`<item>${large}${small}</item>`, `<item>${small}${large}</item>`]) {
      expect(extractArticleImage(xml, policy)).toMatchObject({
        url: 'https://platform.theverge.com/large.jpg',
        credit: 'Large Photo Agency',
      });
    }
  });

  it('does not borrow a credit nested in a different, unselected image', () => {
    const xml = `<item>${media('large', 1600)}${media('small', 400, '<media:credit>Small Photo Agency</media:credit>')}</item>`;
    expect(extractArticleImage(xml, policy)).toMatchObject({ url: 'https://platform.theverge.com/large.jpg', credit: null });
  });

  it('applies item- and group-level credits by Media RSS precedence (most specific wins)', () => {
    const itemLevel = `<item><media:credit>Item Agency</media:credit>${media('large', 1600)}${media('small', 400, '<media:credit>Small Agency</media:credit>')}</item>`;
    expect(extractArticleImage(itemLevel, policy)?.credit).toBe('Item Agency');

    const overridden = `<item><media:credit>Item Agency</media:credit>${media('large', 1600, '<media:credit>Large Agency</media:credit>')}</item>`;
    expect(extractArticleImage(overridden, policy)?.credit).toBe('Large Agency');

    const grouped = `<item>
      <media:group><media:credit>Group A Agency</media:credit>${media('small', 400)}</media:group>
      <media:group>${media('large', 1600)}</media:group>
    </item>`;
    expect(extractArticleImage(grouped, policy)).toMatchObject({ url: 'https://platform.theverge.com/large.jpg', credit: null });
  });

  it('returns null when the deciding level has several distinct credits', () => {
    const xml = `<item><media:credit>Agency One</media:credit><media:credit>Agency Two</media:credit>${media('large', 1600)}</item>`;
    expect(extractArticleImage(xml, policy)).toMatchObject({ url: 'https://platform.theverge.com/large.jpg', credit: null });
  });

  it('gives non-Media-RSS images an item credit only when the entry has one image and one credit', () => {
    const twoImages = `<item><media:credit>Item Agency</media:credit>
      <description><![CDATA[<img src="https://platform.theverge.com/a.jpg"><img src="https://platform.theverge.com/b.jpg">]]></description></item>`;
    expect(extractArticleImage(twoImages, policy)).toMatchObject({ url: 'https://platform.theverge.com/a.jpg', credit: null });

    const nestedElsewhere = `<item>${media('blocked', 1600, '<media:credit>Other Agency</media:credit>').replace('platform.theverge.com', 'images.other.example')}
      <description><![CDATA[<img src="https://platform.theverge.com/a.jpg">]]></description></item>`;
    expect(extractArticleImage(nestedElsewhere, policy)).toMatchObject({ url: 'https://platform.theverge.com/a.jpg', credit: null });

    const ownAttribute = `<item><description><![CDATA[<img src="https://platform.theverge.com/a.jpg" data-credit="Photo: Desk"><img src="https://platform.theverge.com/b.jpg">]]></description></item>`;
    expect(extractArticleImage(ownAttribute, policy)?.credit).toBe('Photo: Desk');
  });

  it('decodes credit text once and keeps CDATA credit text literal', () => {
    const credit = (inner: string) => extractArticleImage(`<item><media:credit>${inner}</media:credit>${media('large', 1600)}</item>`, policy)?.credit;
    expect(credit('Smith &amp; Co')).toBe('Smith & Co');
    expect(credit('Smith &amp;amp; Co')).toBe('Smith &amp; Co');
    expect(credit('<![CDATA[Smith &amp; Co]]>')).toBe('Smith &amp; Co');
  });

  it('never uses author or byline elements as image credits', () => {
    const xml = `<item><author>writer@example.com (Staff Writer)</author><dc:creator>Staff Writer</dc:creator>${media('large', 1600)}</item>`;
    expect(extractArticleImage(xml, policy)?.credit).toBeNull();
  });
});
