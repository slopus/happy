import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTransition } from './transitions';
import { bootstrapWorkspace } from './state/bootstrap';
import { readState, readEvents } from './state/io';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-trans-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('applyTransition', () => {
    it('moves plan → design and appends history + event', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const state = await applyTransition(workspace, 'design');
        expect(state.step).toBe('design');
        expect(state.history.at(-1)).toMatchObject({ from: 'plan', to: 'design' });
        const events = await readEvents(workspace);
        const transitions = events.filter((e) => e.type === 'step.transition');
        expect(transitions).toHaveLength(1);
        expect(transitions[0].payload).toMatchObject({ from: 'plan', to: 'design' });
    });

    it('allows free backward transitions (work → plan)', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const state = await applyTransition(workspace, 'plan');
        expect(state.step).toBe('plan');
        expect(state.history.at(-1)).toMatchObject({ from: 'work', to: 'plan' });
    });

    it('is a no-op when target step equals current step', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const before = await readState(workspace);
        const state = await applyTransition(workspace, 'plan');
        expect(state).toEqual(before);
        const events = await readEvents(workspace);
        expect(events.filter((e) => e.type === 'step.transition')).toHaveLength(0);
    });

    it('records work.startedAt the first time work is entered', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await applyTransition(workspace, 'work');
        const state = await readState(workspace);
        expect(state.work.startedAt).not.toBeNull();
    });

    it('preserves work.startedAt across re-entries', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await applyTransition(workspace, 'work');
        const first = (await readState(workspace)).work.startedAt;
        await applyTransition(workspace, 'plan');
        await applyTransition(workspace, 'work');
        const second = (await readState(workspace)).work.startedAt;
        expect(second).toBe(first);
    });

    it('throws when state.json is missing', async () => {
        await expect(applyTransition(workspace, 'plan')).rejects.toThrow();
    });
});
