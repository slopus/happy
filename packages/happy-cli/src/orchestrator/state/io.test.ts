import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    readState,
    writeState,
    appendEvent,
    readEvents,
    StateFileCorruptError,
} from './io';
import { createInitialState } from './schema';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-state-io-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('writeState / readState', () => {
    it('writes a state and reads it back unchanged', async () => {
        const state = createInitialState('plan');
        await writeState(workspace, state);
        const roundTrip = await readState(workspace);
        expect(roundTrip).toEqual(state);
    });

    it('writes are atomic — no temp file remains after success', async () => {
        const state = createInitialState('work');
        await writeState(workspace, state);
        const axDir = join(workspace, '.ax');
        const { readdir } = await import('node:fs/promises');
        const entries = await readdir(axDir);
        expect(entries).toContain('state.json');
        expect(entries.filter((e) => e.endsWith('.tmp'))).toHaveLength(0);
    });

    it('throws StateFileCorruptError on invalid JSON', async () => {
        await mkdir(join(workspace, '.ax'), { recursive: true });
        await writeFile(join(workspace, '.ax', 'state.json'), '{ not json');
        await expect(readState(workspace)).rejects.toBeInstanceOf(StateFileCorruptError);
    });

    it('throws StateFileCorruptError when schema invalid', async () => {
        await mkdir(join(workspace, '.ax'), { recursive: true });
        await writeFile(
            join(workspace, '.ax', 'state.json'),
            JSON.stringify({ version: 1, step: 'wrong' }),
        );
        await expect(readState(workspace)).rejects.toBeInstanceOf(StateFileCorruptError);
    });

    it('rejects writing an invalid state up front', async () => {
        const bad = { ...createInitialState('plan'), step: 'nope' } as never;
        await expect(writeState(workspace, bad)).rejects.toThrow();
    });
});

describe('appendEvent / readEvents', () => {
    it('appends an event and reads it back', async () => {
        await appendEvent(workspace, {
            id: 'evt_001',
            at: new Date().toISOString(),
            type: 'step.transition',
            payload: { from: 'plan', to: 'design' },
        });
        const events = await readEvents(workspace);
        expect(events).toHaveLength(1);
        expect(events[0].id).toBe('evt_001');
        expect(events[0].payload).toEqual({ from: 'plan', to: 'design' });
    });

    it('appends multiple events sequentially', async () => {
        for (let i = 0; i < 5; i++) {
            await appendEvent(workspace, {
                id: `evt_${i}`,
                at: new Date().toISOString(),
                type: 'permission.decision',
                payload: { target: 'editPlanMd', decision: 'allow' },
            });
        }
        const events = await readEvents(workspace);
        expect(events).toHaveLength(5);
        expect(events.map((e) => e.id)).toEqual(['evt_0', 'evt_1', 'evt_2', 'evt_3', 'evt_4']);
    });

    it('handles concurrent appends without losing events', async () => {
        await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                appendEvent(workspace, {
                    id: `evt_${i}`,
                    at: new Date().toISOString(),
                    type: 'custom',
                    payload: { i },
                }),
            ),
        );
        const events = await readEvents(workspace);
        expect(events).toHaveLength(20);
        const ids = new Set(events.map((e) => e.id));
        expect(ids.size).toBe(20);
    });

    it('returns empty array when events.jsonl does not exist', async () => {
        const events = await readEvents(workspace);
        expect(events).toEqual([]);
    });
});
