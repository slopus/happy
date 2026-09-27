import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readCodexOutput } from './codexOutputReader';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
describe('Codex output storage gate', () => {
    it('stops inside a burst chunk and preserves UTF-8, CRLF and the final unterminated line', async () => {
        const input = new PassThrough();
        const controller = new AbortController();
        const seen: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const done = readCodexOutput(input, { signal: controller.signal,
            beforeLine: async () => { if (seen.length === 1) await gate; }, onLine: line => { seen.push(line); } });
        const bytes = Buffer.from('한글\r\nsecond\nlast');
        input.write(bytes.subarray(0, 2)); input.end(bytes.subarray(2));
        await tick(); expect(seen).toEqual(['한글']);
        expect(input.readableFlowing).not.toBe(true);
        release(); await done; expect(seen).toEqual(['한글', 'second', 'last']);
        expect(input.listenerCount('readable')).toBe(0);
    });
    it('aborts a blocked gate without destroying the provider pipe or leaking listeners', async () => {
        const input = new PassThrough(); const controller = new AbortController();
        const seen: string[] = [];
        const done = readCodexOutput(input, { signal: controller.signal,
            beforeLine: () => new Promise(() => {}), onLine: line => { seen.push(line); } });
        const rejected = expect(done).rejects.toThrow(/abort/i);
        input.write('held\n'); await tick(); controller.abort(); await rejected;
        expect(seen).toEqual([]); expect(input.destroyed).toBe(false);
        expect(input.listenerCount('readable')).toBe(0); input.destroy();
    });
    it('refuses an oversized line without delivering a truncated message', async () => {
        const input = new PassThrough(); const seen: string[] = [];
        const done = readCodexOutput(input, { signal: new AbortController().signal, maxLineBytes: 4,
            beforeLine: async () => {}, onLine: line => { seen.push(line); } });
        const rejected = expect(done).rejects.toThrow(/line.*limit/i);
        input.end('12345\n'); await rejected; expect(seen).toEqual([]); input.destroy();
    });
    it('releases listeners when aborted while waiting for bytes', async () => {
        const input = new PassThrough(); const controller = new AbortController();
        const done = readCodexOutput(input, { signal: controller.signal, beforeLine: async () => {}, onLine: () => {} });
        const rejected = expect(done).rejects.toThrow(/abort/i);
        await tick(); controller.abort(); await rejected;
        for (const name of ['readable', 'end', 'close', 'error']) expect(input.listenerCount(name)).toBe(0);
        input.destroy();
    });
});
