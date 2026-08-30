import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicSessionShareBrowserPath, isPublicSessionSharePath } from './publicSessionShareRouting';

afterEach(() => vi.unstubAllGlobals());

describe('isPublicSessionSharePath', () => {
    it('isolates only public share routes from the authenticated workspace', () => {
        expect(isPublicSessionSharePath('/share/abc')).toBe(true);
        expect(isPublicSessionSharePath('/share/abc/')).toBe(true);
        expect(isPublicSessionSharePath('/share')).toBe(false);
        expect(isPublicSessionSharePath('/session/abc')).toBe(false);
        expect(isPublicSessionSharePath('/')).toBe(false);
    });
});

describe('isPublicSessionShareBrowserPath', () => {
    it('detects the current public browser route without reading app persistence', () => {
        vi.stubGlobal('location', { pathname: '/share/public-id' });
        expect(isPublicSessionShareBrowserPath()).toBe(true);
    });
});
