import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { countValidLines, iterateJsonl, readJsonlHeader } from './jsonlParser';

function makeTmpDir(): string {
    const dir = join(tmpdir(), `jsonl-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

function writeFile(dir: string, name: string, lines: string[]): string {
    const path = join(dir, name);
    writeFileSync(path, lines.join('\n') + (lines.length ? '\n' : ''));
    return path;
}

describe('iterateJsonl', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) {
            if (existsSync(d)) rmSync(d, { recursive: true, force: true });
        }
    });

    it('yields valid lines and skips invalid ones', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }),
            'not-json-at-all',
            JSON.stringify({ type: 'assistant', uuid: 'a1', message: { usage: { input_tokens: 1, output_tokens: 2 } } }),
            JSON.stringify({ type: 'system', uuid: 's1' }),
            JSON.stringify({ /* missing required fields */ foo: 'bar' }),
        ]);
        const rows = [];
        for await (const row of iterateJsonl(file)) rows.push(row);
        expect(rows.map(r => r.type)).toEqual(['user', 'assistant', 'system']);
    });

    it('skips blank lines without error', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            '',
            '   ',
            JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }),
            '',
        ]);
        const rows = [];
        for await (const row of iterateJsonl(file)) rows.push(row);
        expect(rows).toHaveLength(1);
    });

    it('returns empty iterator for empty file', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', []);
        const rows = [];
        for await (const row of iterateJsonl(file)) rows.push(row);
        expect(rows).toHaveLength(0);
    });
});

describe('countValidLines', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) {
            if (existsSync(d)) rmSync(d, { recursive: true, force: true });
        }
    });

    it('counts only schema-valid lines', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hi' } }),
            'corrupt-line',
            JSON.stringify({ type: 'assistant', uuid: 'a1' }),
            JSON.stringify({ unrelated: true }),
        ]);
        expect(await countValidLines(file)).toBe(2);
    });
});

describe('readJsonlHeader', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const d of dirs.splice(0)) {
            if (existsSync(d)) rmSync(d, { recursive: true, force: true });
        }
    });

    it('extracts summary, cwd, sessionId and first user text', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({ type: 'summary', summary: 'Listing files', leafUuid: 'leaf-xyz' }),
            JSON.stringify({
                type: 'user',
                uuid: 'u1',
                cwd: '/Users/me/proj',
                sessionId: '12345678-1234-1234-1234-123456789abc',
                message: { role: 'user', content: 'list files in this directory' },
            }),
            JSON.stringify({
                type: 'assistant',
                uuid: 'a1',
                cwd: '/Users/me/proj',
                sessionId: '12345678-1234-1234-1234-123456789abc',
                message: { content: [{ type: 'text', text: 'Sure.' }] },
            }),
        ]);
        const header = await readJsonlHeader(file);
        expect(header).not.toBeNull();
        expect(header!.summary).toEqual({ summary: 'Listing files', leafUuid: 'leaf-xyz' });
        expect(header!.firstCwd).toBe('/Users/me/proj');
        expect(header!.claudeSessionId).toBe('12345678-1234-1234-1234-123456789abc');
        expect(header!.firstUserText).toBe('list files in this directory');
        expect(header!.sizeBytes).toBeGreaterThan(0);
    });

    it('handles user message with block-array content', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({
                type: 'user',
                uuid: 'u1',
                cwd: '/x',
                sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                message: {
                    content: [
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } },
                        { type: 'text', text: 'what is this?' },
                    ],
                },
            }),
        ]);
        const header = await readJsonlHeader(file);
        expect(header!.firstUserText).toBe('what is this?');
    });

    it('truncates long user text', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const longText = 'a'.repeat(200);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({
                type: 'user',
                uuid: 'u1',
                cwd: '/x',
                sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                message: { content: longText },
            }),
        ]);
        const header = await readJsonlHeader(file);
        expect(header!.firstUserText!.length).toBeLessThanOrEqual(60);
        expect(header!.firstUserText!.endsWith('...')).toBe(true);
    });

    it('returns null when neither cwd nor sessionId is present', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({ type: 'system', uuid: 's1' }),
        ]);
        const header = await readJsonlHeader(file);
        expect(header).toBeNull();
    });

    it('returns null for nonexistent file', async () => {
        const header = await readJsonlHeader('/tmp/does-not-exist-' + Date.now() + '.jsonl');
        expect(header).toBeNull();
    });

    it('records mtime from stat', async () => {
        const dir = makeTmpDir();
        dirs.push(dir);
        const file = writeFile(dir, 'a.jsonl', [
            JSON.stringify({
                type: 'user',
                uuid: 'u1',
                cwd: '/x',
                sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                message: { content: 'hi' },
            }),
        ]);
        const fixed = new Date('2025-06-15T12:00:00Z');
        utimesSync(file, fixed, fixed);
        const header = await readJsonlHeader(file);
        expect(Math.abs(header!.mtimeMs - fixed.getTime())).toBeLessThan(1500);
    });
});
