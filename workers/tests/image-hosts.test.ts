import { describe, expect, it } from 'vitest';
import { approvedImageHostsForSource } from '../src/utils/image-hosts';
import { validateArticleImageUrl } from '../src/utils/image-policy';

describe('approvedImageHostsForSource', () => {
  it('approves exactly platform.theverge.com for the canonical "The Verge" source', () => {
    expect(approvedImageHostsForSource('The Verge')).toEqual(['platform.theverge.com']);
  });

  it.each([
    'TechCrunch',
    'Ars Technica',
    'Unknown Source',
    '',
    'the verge',
    'THE VERGE',
    ' The Verge',
    'The Verge ',
    'TheVerge',
    'theverge.com',
    '__proto__',
    'constructor',
    'hasOwnProperty',
    'toString',
  ])('gives no hosts to %j', (name) => {
    expect(approvedImageHostsForSource(name)).toEqual([]);
  });

  it('gives no hosts to missing or non-string names', () => {
    expect(approvedImageHostsForSource(null)).toEqual([]);
    expect(approvedImageHostsForSource(undefined)).toEqual([]);
    expect(approvedImageHostsForSource(42 as unknown as string)).toEqual([]);
  });

  it('returns frozen lists that callers cannot widen', () => {
    const verge = approvedImageHostsForSource('The Verge') as string[];
    const none = approvedImageHostsForSource('TechCrunch') as string[];
    expect(Object.isFrozen(verge)).toBe(true);
    expect(Object.isFrozen(none)).toBe(true);
    expect(() => verge.push('evil.example')).toThrow(TypeError);
    expect(() => none.push('platform.theverge.com')).toThrow(TypeError);
    expect(approvedImageHostsForSource('The Verge')).toEqual(['platform.theverge.com']);
    expect(approvedImageHostsForSource('TechCrunch')).toEqual([]);
  });

  it('does not broaden to wildcards, parent, sibling or sub-domains', () => {
    const allowedHosts = approvedImageHostsForSource('The Verge');
    expect(allowedHosts.some(host => host.includes('*'))).toBe(false);
    expect(validateArticleImageUrl('https://platform.theverge.com/a.jpg', { allowedHosts })).toBe('https://platform.theverge.com/a.jpg');
    for (const host of ['theverge.com', 'www.theverge.com', 'cdn.platform.theverge.com', 'platform.theverge.com.evil.example', 'cdn.vox-cdn.com']) {
      expect(validateArticleImageUrl(`https://${host}/a.jpg`, { allowedHosts })).toBeNull();
    }
  });
});
