import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreToolUseCli } from './runPreToolUseCli';
import { bootstrapWorkspace } from '../orchestrator/state/bootstrap';
import { readEvents } from '../orchestrator/state/io';
import { Readable } from 'node:stream';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-hook-cli-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

function stdinFor(payload: object): Readable {
    return Readable.from([JSON.stringify(payload)]);
}

describe('runPreToolUseCli', () => {
    it('passes through (exit 0, no output) when workspace is not an AX workspace', async () => {
        const stdout = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({ tool_name: 'Write', tool_input: { file_path: 'foo.ts', content: '' } }),
            stdout,
        });
        expect(exit).toBe(0);
        expect(stdout.text()).toBe('');
    });

    it('allows a permitted write (exit 0)', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const stdout = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Write',
                tool_input: { file_path: join(workspace, 'AX_PROJECT_PLAN.md'), content: '# X' },
            }),
            stdout,
        });
        expect(exit).toBe(0);
    });

    it('blocks a forbidden write (exit 2) and writes reason to stderr', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const stdout = new MemorySink();
        const stderr = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Write',
                tool_input: { file_path: join(workspace, 'src/app.tsx'), content: 'x' },
            }),
            stdout,
            stderr,
        });
        expect(exit).toBe(2);
        expect(stderr.text()).toMatch(/plan/i);
    });

    it('appends a hook.blocked event to events.jsonl on deny', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Write',
                tool_input: { file_path: join(workspace, 'src/x.ts'), content: '' },
            }),
            stdout: new MemorySink(),
            stderr: new MemorySink(),
        });
        const events = await readEvents(workspace);
        const blocked = events.filter((e) => e.type === 'hook.blocked');
        expect(blocked).toHaveLength(1);
        expect(blocked[0].payload).toMatchObject({ tool: 'Write' });
    });

    it('denies plan md edits with a panel-pointing reason in work + ask state', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const stdout = new MemorySink();
        const stderr = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Edit',
                tool_input: { file_path: join(workspace, 'AX_PROJECT_PLAN.md') },
            }),
            stdout,
            stderr,
        });
        // The hook denies (exit 2) and points the user to AxPermissionsPanel.
        // This keeps the UX one-modal-clean rather than relying on Claude Code's
        // native ask flow which is not integrated with happy's permission UI.
        expect(exit).toBe(2);
        expect(stderr.text()).toMatch(/항상 허용|패널/);
        expect(stderr.text()).toMatch(/AX_PROJECT_PLAN/);
    });

    it('survives malformed stdin gracefully (exit 0, no block)', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: Readable.from(['{ this is not json']),
            stdout: new MemorySink(),
            stderr: new MemorySink(),
        });
        expect(exit).toBe(0);
    });
});

class MemorySink {
    private chunks: string[] = [];
    write(chunk: string): boolean {
        this.chunks.push(chunk);
        return true;
    }
    text(): string {
        return this.chunks.join('');
    }
}
