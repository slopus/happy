import { describe, expect, it } from 'vitest';
import { resolvePreviewPath } from './previewResources';
describe('HTML resource path boundary', () => {
    it('resolves a sibling resource and preserves its SVG fragment without a network URL', () => {
        expect(resolvePreviewPath('../assets/轨道 图.svg#mark', '/work/demo/index.html', '/work')).toEqual({ path: '/work/assets/轨道 图.svg', fragment: '#mark' });
    });
    it('refuses outside paths, remote URLs, protocol-relative references and absolute file URLs', () => {
        for (const value of ['../../secret.txt', 'https://host/x.js', '//host/x.js', 'file:///etc/passwd', '%2e%2e/%2e%2e/secret']) {
            expect(() => resolvePreviewPath(value, '/work/demo/index.html', '/work')).toThrow();
        }
    });
    it('resolves a root-relative resource only inside the session workspace', () => {
        expect(resolvePreviewPath('/assets/icon.png', '/work/demo/index.html', '/work')).toEqual({ path: '/work/assets/icon.png', fragment: '' });
    });
});

it.each([
    ['images/a%23b.png', '/work/images/a#b.png', ''],
    ['images/a%3Fb.png', '/work/images/a?b.png', ''],
    ['images/a%23b%3Fc.svg?v=1#mark%20two', '/work/images/a#b?c.svg', '#mark%20two'],
    ['images/%E8%BD%A8%E9%81%93%20%E5%9B%BE.svg?cache=%#mark', '/work/images/轨道 图.svg', '#mark'],
])('preserves encoded filename delimiters in %s', (reference, path, fragment) => {
    expect(resolvePreviewPath(reference, '/work/index.html', '/work')).toEqual({ path, fragment });
});

it.each([
    '%2e%2e/%2e%2e/secret.png?ignored=%',
    'https%3A%2F%2Fhost%2Fa.png#part',
    '%2F%2Fhost/a.png',
    'assets/a%5Cb.png',
    'assets/a%00b.png',
])('retains the path boundary for encoded unsafe reference %s', reference => {
    expect(() => resolvePreviewPath(reference, '/work/demo/index.html', '/work')).toThrow();
});
