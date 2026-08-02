import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { createKimiSessionScanner } from './kimiSessionScanner';

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

const prompt = (text: string) => line({ type: 'turn.prompt', input: [{ type: 'text', text }] });
const stepBegin = () => line({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: '0', step: 1 } });
const textPart = (text: string) => line({
    type: 'context.append_loop_event',
    event: { type: 'content.part', part: { type: 'text', text } },
});

async function withWireFile(run: (file: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-scanner-'));
    const file = join(dir, 'wire.jsonl');
    try {
        await run(file);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

describe('createKimiSessionScanner', () => {
    it('emits envelopes for content already on disk', async () => {
        await withWireFile(async (file) => {
            await writeFile(file, prompt('oi') + stepBegin() + textPart('ola'));

            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
            });
            await scanner.sync();
            await scanner.stop();

            expect(seen.map((e) => e.ev.t)).toEqual(['text', 'turn-start', 'text', 'turn-end']);
            expect(seen[0].role).toBe('user');
        });
    });

    it('picks up records appended after the first read', async () => {
        await withWireFile(async (file) => {
            await writeFile(file, prompt('primeiro'));

            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
            });
            await scanner.sync();
            expect(seen).toHaveLength(1);

            await appendFile(file, stepBegin() + textPart('resposta'));
            await scanner.sync();
            await scanner.stop();

            expect(seen.map((e) => e.ev.t)).toEqual(['text', 'turn-start', 'text', 'turn-end']);
        });
    });

    it('holds back a partially written line until its newline arrives', async () => {
        await withWireFile(async (file) => {
            await writeFile(file, prompt('completa'));

            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
            });
            await scanner.sync();

            const partial = prompt('cortada');
            await appendFile(file, partial.slice(0, 20));
            await scanner.sync();
            expect(seen).toHaveLength(1);

            await appendFile(file, partial.slice(20));
            await scanner.sync();
            await scanner.stop();

            expect(seen).toHaveLength(2);
            expect(seen[1].ev).toEqual({ t: 'text', text: 'cortada' });
        });
    });

    it('startAtEnd skips existing history and mirrors only new records', async () => {
        await withWireFile(async (file) => {
            await writeFile(file, prompt('historico antigo'));

            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
                startAtEnd: true,
            });
            await scanner.sync();
            expect(seen).toEqual([]);

            await appendFile(file, prompt('novo'));
            await scanner.sync();
            await scanner.stop();

            expect(seen).toHaveLength(1);
            expect(seen[0].ev).toEqual({ t: 'text', text: 'novo' });
        });
    });

    it('closes an interrupted turn when stopped', async () => {
        await withWireFile(async (file) => {
            await writeFile(file, prompt('oi') + stepBegin() + textPart('pensando'));

            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
            });
            await scanner.sync();
            await scanner.stop('cancelled');

            expect(seen.at(-1)?.ev).toEqual({ t: 'turn-end', status: 'cancelled' });
        });
    });

    it('tolerates a transcript that does not exist yet', async () => {
        await withWireFile(async (file) => {
            const seen: SessionEnvelope[] = [];
            const scanner = createKimiSessionScanner({
                wireFile: file,
                onEnvelopes: (envelopes) => seen.push(...envelopes),
            });
            await scanner.sync();

            await writeFile(file, prompt('apareceu'));
            await scanner.sync();
            await scanner.stop();

            expect(seen).toHaveLength(1);
        });
    });
});
