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
