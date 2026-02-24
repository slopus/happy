import { describe, it, expect } from 'vitest';
import {
    parsePositiveInt,
    parseLineAndColumn,
    parseLocalFileReference,
    isLikelyRelativeFilePath,
    normalizeDirectoryPath,
    isPathInsideDirectory,
    isLikelyAbsoluteFilePath,
    joinPosixPath,
    buildSessionFileHref,
    resolveMarkdownLink,
    encodeFilePathForRoute,
} from './markdownLinkUtils';

// ---------------------------------------------------------------------------
// parsePositiveInt
// ---------------------------------------------------------------------------
describe('parsePositiveInt', () => {
    it('returns number for valid positive integer', () => {
        expect(parsePositiveInt('42')).toBe(42);
    });
    it('returns undefined for zero', () => {
        expect(parsePositiveInt('0')).toBeUndefined();
    });
    it('returns undefined for negative', () => {
        expect(parsePositiveInt('-5')).toBeUndefined();
    });
    it('returns undefined for empty string', () => {
        expect(parsePositiveInt('')).toBeUndefined();
    });
    it('returns undefined for undefined', () => {
        expect(parsePositiveInt(undefined)).toBeUndefined();
    });
    it('returns undefined for non-numeric', () => {
        expect(parsePositiveInt('abc')).toBeUndefined();
    });
    it('parses integer part of float string', () => {
        expect(parsePositiveInt('3.7')).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// parseLineAndColumn
// ---------------------------------------------------------------------------
describe('parseLineAndColumn', () => {
    it('returns empty for undefined', () => {
        expect(parseLineAndColumn(undefined)).toEqual({});
    });
    it('returns empty for empty string', () => {
        expect(parseLineAndColumn('')).toEqual({});
    });
    it('parses L10 format', () => {
        expect(parseLineAndColumn('L10')).toEqual({ line: 10 });
    });
    it('parses L10C5 format', () => {
        expect(parseLineAndColumn('L10C5')).toEqual({ line: 10, column: 5 });
    });
    it('parses l10c5 (lowercase)', () => {
        expect(parseLineAndColumn('l10c5')).toEqual({ line: 10, column: 5 });
    });
    it('parses simple line number', () => {
        expect(parseLineAndColumn('42')).toEqual({ line: 42 });
    });
    it('parses line:column format', () => {
        expect(parseLineAndColumn('42:10')).toEqual({ line: 42, column: 10 });
    });
    it('returns empty for unrecognized format', () => {
        expect(parseLineAndColumn('foo')).toEqual({});
    });
    it('trims whitespace', () => {
        expect(parseLineAndColumn('  L5  ')).toEqual({ line: 5 });
    });
});

// ---------------------------------------------------------------------------
// parseLocalFileReference
// ---------------------------------------------------------------------------
describe('parseLocalFileReference', () => {
    it('parses plain absolute path', () => {
        expect(parseLocalFileReference('/home/user/file.ts')).toEqual({
            filePath: '/home/user/file.ts',
            line: undefined,
            column: undefined,
        });
    });
    it('parses path with line number suffix', () => {
        expect(parseLocalFileReference('/home/user/file.ts:42')).toEqual({
            filePath: '/home/user/file.ts',
            line: 42,
            column: undefined,
        });
    });
    it('parses path with line:column suffix (greedy — last :number wins as line)', () => {
        // Greedy regex: (.*) eats "path:42", leaving ":10" as the matched line.
        // This is intentional to handle paths containing colons.
        // Use hash syntax (#L42C10) for reliable line+column.
        expect(parseLocalFileReference('/home/user/file.ts:42:10')).toEqual({
            filePath: '/home/user/file.ts:42',
            line: 10,
            column: undefined,
        });
    });
    it('parses hash with L-format', () => {
        expect(parseLocalFileReference('/home/user/file.ts#L10C5')).toEqual({
            filePath: '/home/user/file.ts',
            line: 10,
            column: 5,
        });
    });
    it('parses hash with simple number', () => {
        expect(parseLocalFileReference('/home/user/file.ts#100')).toEqual({
            filePath: '/home/user/file.ts',
            line: 100,
            column: undefined,
        });
    });
    it('hash takes priority over colon suffix', () => {
        expect(parseLocalFileReference('/home/user/file.ts:99#L10')).toEqual({
            filePath: '/home/user/file.ts:99',
            line: 10,
            column: undefined,
        });
    });
    it('strips file:// prefix', () => {
        expect(parseLocalFileReference('file:///home/user/file.ts:42')).toEqual({
            filePath: '/home/user/file.ts',
            line: 42,
            column: undefined,
        });
    });
    it('decodes percent-encoded path', () => {
        expect(parseLocalFileReference('/home/user/my%20file.ts')).toEqual({
            filePath: '/home/user/my file.ts',
            line: undefined,
            column: undefined,
        });
    });
    it('handles path with parentheses (Expo Router)', () => {
        expect(parseLocalFileReference('/repo/app/(app)/session/[id]/file.tsx:103')).toEqual({
            filePath: '/repo/app/(app)/session/[id]/file.tsx',
            line: 103,
            column: undefined,
        });
    });
});

// ---------------------------------------------------------------------------
// isLikelyRelativeFilePath
// ---------------------------------------------------------------------------
describe('isLikelyRelativeFilePath', () => {
    it('returns true for ./ prefix', () => {
        expect(isLikelyRelativeFilePath('./src/index.ts')).toBe(true);
    });
    it('returns true for ../ prefix', () => {
        expect(isLikelyRelativeFilePath('../utils/helper.ts')).toBe(true);
    });
    it('returns true for path with slash', () => {
        expect(isLikelyRelativeFilePath('src/index.ts')).toBe(true);
    });
    it('returns false for absolute path', () => {
        expect(isLikelyRelativeFilePath('/usr/local/bin')).toBe(false);
    });
    it('returns false for URL with scheme', () => {
        expect(isLikelyRelativeFilePath('https://example.com/path')).toBe(false);
    });
    it('returns false for hash-only', () => {
        expect(isLikelyRelativeFilePath('#section')).toBe(false);
    });
    it('returns false for empty string', () => {
        expect(isLikelyRelativeFilePath('')).toBe(false);
    });
    it('returns false for bare filename without slash', () => {
        expect(isLikelyRelativeFilePath('README.md')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// normalizeDirectoryPath
// ---------------------------------------------------------------------------
describe('normalizeDirectoryPath', () => {
    it('returns null for null', () => {
        expect(normalizeDirectoryPath(null)).toBeNull();
    });
    it('returns null for empty', () => {
        expect(normalizeDirectoryPath('')).toBeNull();
    });
    it('returns null for relative path', () => {
        expect(normalizeDirectoryPath('relative/path')).toBeNull();
    });
    it('returns / for root', () => {
        expect(normalizeDirectoryPath('/')).toBe('/');
    });
    it('strips trailing slashes', () => {
        expect(normalizeDirectoryPath('/home/user/')).toBe('/home/user');
    });
    it('strips multiple trailing slashes', () => {
        expect(normalizeDirectoryPath('/home/user///')).toBe('/home/user');
    });
    it('keeps clean path as-is', () => {
        expect(normalizeDirectoryPath('/home/user')).toBe('/home/user');
    });
});

// ---------------------------------------------------------------------------
// isPathInsideDirectory
// ---------------------------------------------------------------------------
describe('isPathInsideDirectory', () => {
    it('returns true for exact match', () => {
        expect(isPathInsideDirectory('/home/user', '/home/user')).toBe(true);
    });
    it('returns true for child path', () => {
        expect(isPathInsideDirectory('/home/user/file.ts', '/home/user')).toBe(true);
    });
    it('returns false for sibling path', () => {
        expect(isPathInsideDirectory('/home/other/file.ts', '/home/user')).toBe(false);
    });
    it('returns false for prefix-match that is not a directory boundary', () => {
        expect(isPathInsideDirectory('/home/username/file.ts', '/home/user')).toBe(false);
    });
    it('returns false for null directory', () => {
        expect(isPathInsideDirectory('/home/user/file.ts', null)).toBe(false);
    });
    it('root dir matches any absolute path', () => {
        expect(isPathInsideDirectory('/anything', '/')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// isLikelyAbsoluteFilePath
// ---------------------------------------------------------------------------
describe('isLikelyAbsoluteFilePath', () => {
    const ctx = {
        sessionWorkingDirectory: '/home/coder/project',
        sessionHomeDirectory: '/home/coder',
    };
    it('returns true for path in working directory', () => {
        expect(isLikelyAbsoluteFilePath('/home/coder/project/src/index.ts', ctx)).toBe(true);
    });
    it('returns true for path in home directory', () => {
        expect(isLikelyAbsoluteFilePath('/home/coder/.config/settings.json', ctx)).toBe(true);
    });
    it('returns false for path outside both directories', () => {
        expect(isLikelyAbsoluteFilePath('/etc/hosts', ctx)).toBe(false);
    });
    it('returns false for non-absolute path', () => {
        expect(isLikelyAbsoluteFilePath('relative/path', ctx)).toBe(false);
    });
    it('returns false for // prefix', () => {
        expect(isLikelyAbsoluteFilePath('//home/coder/project/file.ts', ctx)).toBe(false);
    });
    it('returns false when context dirs are null', () => {
        expect(isLikelyAbsoluteFilePath('/home/coder/file.ts', {
            sessionWorkingDirectory: null,
            sessionHomeDirectory: null,
        })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// joinPosixPath
// ---------------------------------------------------------------------------
describe('joinPosixPath', () => {
    it('joins base and relative', () => {
        expect(joinPosixPath('/home/user', 'src/index.ts')).toBe('/home/user/src/index.ts');
    });
    it('handles ./ in relative', () => {
        expect(joinPosixPath('/home/user', './src/index.ts')).toBe('/home/user/src/index.ts');
    });
    it('handles ../ in relative', () => {
        expect(joinPosixPath('/home/user/project', '../other/file.ts')).toBe('/home/user/other/file.ts');
    });
    it('handles multiple ../', () => {
        expect(joinPosixPath('/home/user/a/b', '../../c/d.ts')).toBe('/home/user/c/d.ts');
    });
    it('does not go above root', () => {
        expect(joinPosixPath('/home', '../../file.ts')).toBe('/file.ts');
    });
    it('handles trailing slash on base', () => {
        expect(joinPosixPath('/home/user/', 'file.ts')).toBe('/home/user/file.ts');
    });
});

// ---------------------------------------------------------------------------
// encodeFilePathForRoute
// ---------------------------------------------------------------------------
describe('encodeFilePathForRoute', () => {
    it('encodes ASCII path to base64', () => {
        const encoded = encodeFilePathForRoute('/home/user/file.ts');
        expect(atob(encoded)).toBe('/home/user/file.ts');
    });
    it('encodes UTF-8 path correctly', () => {
        const encoded = encodeFilePathForRoute('/home/user/文件.ts');
        // Decode manually: base64 → binary → UTF-8
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        expect(new TextDecoder().decode(bytes)).toBe('/home/user/文件.ts');
    });
});

// ---------------------------------------------------------------------------
// buildSessionFileHref
// ---------------------------------------------------------------------------
describe('buildSessionFileHref', () => {
    it('builds basic href with encoded path', () => {
        const href = buildSessionFileHref({ sessionId: 'sess1', filePath: '/home/file.ts' });
        expect(href).toContain('/session/sess1/file?');
        expect(href).toContain('view=file');
        // The path should be URL-encoded base64
        expect(href).toContain('path=');
    });
    it('includes line and column params', () => {
        const href = buildSessionFileHref({ sessionId: 's1', filePath: '/f.ts', line: 10, column: 5 });
        expect(href).toContain('line=10');
        expect(href).toContain('column=5');
    });
    it('URL-encodes base64 so + is safe in query string', () => {
        // Generate a path that produces base64 with + characters.
        // btoa('>>>>>>') = 'Pj4+Pj4+' (contains +)
        // We'll use a path that is likely to produce + in base64.
        const href = buildSessionFileHref({ sessionId: 's1', filePath: '>>>>>>' });
        // The encoded path should NOT contain raw + (it should be %2B if base64 had +)
        const pathParam = href.split('path=')[1].split('&')[0];
        expect(pathParam).not.toContain('+');
        // Decoding the URL component and then base64 should give back the original
        const base64 = decodeURIComponent(pathParam);
        expect(atob(base64)).toBe('>>>>>>');
    });
});

// ---------------------------------------------------------------------------
// resolveMarkdownLink
// ---------------------------------------------------------------------------
describe('resolveMarkdownLink', () => {
    const ctx = {
        sessionId: 'session-123',
        sessionWorkingDirectory: '/home/coder/project',
        sessionHomeDirectory: '/home/coder',
    };

    it('returns href with _blank for http URLs', () => {
        const result = resolveMarkdownLink({ rawUrl: 'https://example.com', ...ctx });
        expect(result).toEqual({ href: 'https://example.com', target: '_blank' });
    });

    it('returns href with _blank for mailto', () => {
        const result = resolveMarkdownLink({ rawUrl: 'mailto:a@b.com', ...ctx });
        expect(result).toEqual({ href: 'mailto:a@b.com', target: '_blank' });
    });

    it('resolves absolute path inside working directory to file route', () => {
        const result = resolveMarkdownLink({ rawUrl: '/home/coder/project/src/index.ts', ...ctx });
        expect(result.href).toMatch(/^\/session\/session-123\/file\?/);
        expect(result.href).toContain('view=file');
        expect(result.target).toBeUndefined();
    });

    it('resolves absolute path with line number', () => {
        const result = resolveMarkdownLink({ rawUrl: '/home/coder/project/src/index.ts:42', ...ctx });
        expect(result.href).toContain('line=42');
    });

    it('resolves absolute path inside home directory', () => {
        const result = resolveMarkdownLink({ rawUrl: '/home/coder/.config/settings.json', ...ctx });
        expect(result.href).toMatch(/^\/session\/session-123\/file\?/);
    });

    it('does not resolve absolute path outside known directories', () => {
        const result = resolveMarkdownLink({ rawUrl: '/etc/hosts', ...ctx });
        expect(result).toEqual({ href: '/etc/hosts' });
    });

    it('resolves relative path to file route', () => {
        const result = resolveMarkdownLink({ rawUrl: 'src/index.ts', ...ctx });
        expect(result.href).toMatch(/^\/session\/session-123\/file\?/);
    });

    it('resolves relative path with ../ and line number', () => {
        const result = resolveMarkdownLink({ rawUrl: '../other/file.ts:10', ...ctx });
        expect(result.href).toContain('line=10');
    });

    it('resolves relative path with hash line+column', () => {
        const result = resolveMarkdownLink({ rawUrl: '../other/file.ts#L10C5', ...ctx });
        expect(result.href).toContain('line=10');
        expect(result.href).toContain('column=5');
    });

    it('does not resolve relative path without sessionWorkingDirectory', () => {
        const result = resolveMarkdownLink({
            rawUrl: 'src/index.ts',
            sessionId: 'sess1',
            sessionWorkingDirectory: null,
            sessionHomeDirectory: null,
        });
        expect(result).toEqual({ href: 'src/index.ts' });
    });

    it('returns href with _blank for custom schemes', () => {
        const result = resolveMarkdownLink({ rawUrl: 'vscode://open/file', ...ctx });
        expect(result).toEqual({ href: 'vscode://open/file', target: '_blank' });
    });

    it('passes through empty URL', () => {
        const result = resolveMarkdownLink({ rawUrl: '', ...ctx });
        expect(result).toEqual({ href: '' });
    });

    it('passes through unrecognized string', () => {
        const result = resolveMarkdownLink({ rawUrl: 'just-a-word', ...ctx });
        expect(result).toEqual({ href: 'just-a-word' });
    });

    it('does not resolve absolute path without sessionId', () => {
        const result = resolveMarkdownLink({
            rawUrl: '/home/coder/project/file.ts',
            sessionWorkingDirectory: '/home/coder/project',
            sessionHomeDirectory: '/home/coder',
        });
        expect(result).toEqual({ href: '/home/coder/project/file.ts' });
    });
});
