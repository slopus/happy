import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile, mkdir, access } from 'node:fs/promises';
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

    it('creates .ax/state.json with step=free when requested', async () => {
        await bootstrapWorkspace(workspace, 'free');
        const state = await readState(workspace);
        expect(state.step).toBe('free');
        expect(state.history[0]).toMatchObject({ from: null, to: 'free' });
    });

    it('creates an empty .ax/events.jsonl', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const eventsStat = await stat(join(workspace, '.ax', 'events.jsonl'));
        expect(eventsStat.size).toBe(0);
    });

    it('does NOT create .claude/settings.json when none existed', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await expect(
            access(join(workspace, '.claude', 'settings.json')),
        ).rejects.toThrow();
    });

    it('is idempotent — second call preserves existing state and history', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const first = await readState(workspace);
        await new Promise((r) => setTimeout(r, 10));
        await bootstrapWorkspace(workspace, 'plan');
        const second = await readState(workspace);
        expect(second).toEqual(first);
    });

    it('strips legacy `happy hooks pre-tool-use` entry from .claude/settings.json', async () => {
        await mkdir(join(workspace, '.claude'), { recursive: true });
        await writeFile(
            join(workspace, '.claude', 'settings.json'),
            JSON.stringify({
                env: { MY_VAR: '1' },
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Write|Edit|MultiEdit',
                            hooks: [{ type: 'command', command: 'happy hooks pre-tool-use' }],
                        },
                    ],
                },
            }),
        );
        await bootstrapWorkspace(workspace, 'plan');
        const settings = JSON.parse(
            await readFile(join(workspace, '.claude', 'settings.json'), 'utf8'),
        );
        expect(settings.env).toEqual({ MY_VAR: '1' });
        expect(settings.hooks).toBeUndefined();
    });

    it('preserves unrelated hook entries when stripping the stale one', async () => {
        await mkdir(join(workspace, '.claude'), { recursive: true });
        await writeFile(
            join(workspace, '.claude', 'settings.json'),
            JSON.stringify({
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Write|Edit|MultiEdit',
                            hooks: [
                                { type: 'command', command: 'happy hooks pre-tool-use' },
                                { type: 'command', command: 'user-custom-hook' },
                            ],
                        },
                        {
                            matcher: 'Bash',
                            hooks: [{ type: 'command', command: 'audit-bash' }],
                        },
                    ],
                },
            }),
        );
        await bootstrapWorkspace(workspace, 'plan');
        const settings = JSON.parse(
            await readFile(join(workspace, '.claude', 'settings.json'), 'utf8'),
        );
        expect(settings.hooks.PreToolUse).toHaveLength(2);
        expect(settings.hooks.PreToolUse[0].hooks).toEqual([
            { type: 'command', command: 'user-custom-hook' },
        ]);
        expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe('audit-bash');
    });

    it('leaves .claude/settings.json untouched when no stale entry present', async () => {
        await mkdir(join(workspace, '.claude'), { recursive: true });
        const original = JSON.stringify({ env: { OTHER: '1' } }, null, 2) + '\n';
        await writeFile(join(workspace, '.claude', 'settings.json'), original);
        await bootstrapWorkspace(workspace, 'plan');
        const after = await readFile(join(workspace, '.claude', 'settings.json'), 'utf8');
        expect(after).toBe(original);
    });
});
