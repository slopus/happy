import { describe, expect, it } from 'vitest';
import { getLightPublicUrl, normalizePublicPath } from './files';

describe('normalizePublicPath', () => {
  it('rejects path traversal and absolute paths', () => {
    expect(() => normalizePublicPath('../x')).toThrow();
    expect(() => normalizePublicPath('a/../x')).toThrow();
    expect(() => normalizePublicPath('..\\x')).toThrow();
    expect(() => normalizePublicPath('/x')).toThrow();
    expect(() => normalizePublicPath('\\x')).toThrow();
    expect(() => normalizePublicPath('C:\\x')).toThrow();
    expect(() => normalizePublicPath('C:/x')).toThrow();
  });

  it('returns a normalized relative path', () => {
    expect(normalizePublicPath('foo//bar')).toBe('foo/bar');
    expect(normalizePublicPath('foo/./bar')).toBe('foo/bar');
    expect(normalizePublicPath('foo\\bar\\baz.txt')).toBe('foo/bar/baz.txt');
  });
});

describe('getLightPublicUrl', () => {
  it('encodes each path segment (so # and ? are not treated as URL fragment/query)', () => {
    const env = { PUBLIC_URL: 'http://localhost:3005' } as NodeJS.ProcessEnv;
    const url = getLightPublicUrl(env, 'foo/bar baz#qux?zap');
    expect(url).toBe('http://localhost:3005/files/foo/bar%20baz%23qux%3Fzap');
  });
});
