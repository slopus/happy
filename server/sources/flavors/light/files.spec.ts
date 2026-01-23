import { normalizePublicPath } from './files';
import { describe, expect, it } from 'vitest';

describe('normalizePublicPath', () => {
    it('normalizes paths and strips leading slashes', () => {
        expect(normalizePublicPath('/public/users/u1/a.png')).toBe('public/users/u1/a.png');
        expect(normalizePublicPath('public//users//u1//a.png')).toBe('public/users/u1/a.png');
        expect(normalizePublicPath('public\\users\\u1\\a.png')).toBe('public/users/u1/a.png');
    });

    it('rejects path traversal', () => {
        expect(() => normalizePublicPath('../secret.txt')).toThrow('Invalid path');
    });

    it('sanitizes absolute paths and rejects drive letters', () => {
        expect(normalizePublicPath('/etc/passwd')).toBe('etc/passwd');
        expect(() => normalizePublicPath('C:\\\\windows\\\\system32')).toThrow('Invalid path');
        expect(() => normalizePublicPath('C:windows/system32')).toThrow('Invalid path');
    });
});
