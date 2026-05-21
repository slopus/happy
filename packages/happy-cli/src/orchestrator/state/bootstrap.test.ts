import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from './bootstrap';
import { readState } from './io';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-bootstrap-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('bootstrapWorkspace', () => {
    it('creates .ax/state.json with the requested step', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const state = await readState(workspace);
        expect(state.step).toBe('plan');
        expect(state.history[0]).toMatchObject({ from: null, to: 'plan' });
    });

    it('creates an empty .ax/events.jsonl', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const eventsStat = await stat(join(workspace, '.ax', 'events.jsonl'));
        expect(eventsStat.size).toBe(0);
    });

    it('creates .claude/settings.json with PreToolUse hook registered', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const raw = await readFile(join(workspace, '.claude', 'settings.json'), 'utf8');
        const settings = JSON.parse(raw);
        expect(settings.hooks).toBeDefined();
        expect(settings.hooks.PreToolUse).toBeDefined();
        expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
        expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0);
    });

    it('is idempotent — second call preserves existing state and history', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const first = await readState(workspace);
        // Simulate user progressing the workflow before second bootstrap
        await new Promise((r) => setTimeout(r, 10));
        await bootstrapWorkspace(workspace, 'plan');
        const second = await readState(workspace);
        expect(second).toEqual(first);
    });

    it('preserves an existing user-edited .claude/settings.json by merging hooks', async () => {
        await mkdir(join(workspace, '.claude'), { recursive: true });
        await writeFile(
            join(workspace, '.claude', 'settings.json'),
            JSON.stringify({ env: { MY_VAR: '1' } }),
        );
        await bootstrapWorkspace(workspace, 'plan');
        const settings = JSON.parse(
            await readFile(join(workspace, '.claude', 'settings.json'), 'utf8'),
        );
        expect(settings.env).toEqual({ MY_VAR: '1' });
        expect(settings.hooks.PreToolUse).toBeDefined();
    });
});
