import { describe, expect, it } from 'vitest';
import { encodeFilePath, decodeFilePath } from './filePathEncoding';
describe('UTF-8 file routes', () => {
    it.each(['/tmp/计划 与验收 🚀.md', '/tmp/a+b?.ts', '/tmp/ascii.md'])('round trips %s through a URL query', path => {
        const query = new URLSearchParams(`path=${encodeFilePath(path)}`);
        expect(decodeFilePath(query.get('path')!)).toBe(path);
    });
    it('preserves legacy ASCII base64 routes', () => expect(decodeFilePath(btoa('/tmp/a.ts'))).toBe('/tmp/a.ts'));
    it('preserves legacy Latin-1 filenames', () => expect(decodeFilePath(btoa('/tmp/café.md'))).toBe('/tmp/café.md'));
    it('rejects malformed encodings', () => expect(() => decodeFilePath('!bad')).toThrow());
});
