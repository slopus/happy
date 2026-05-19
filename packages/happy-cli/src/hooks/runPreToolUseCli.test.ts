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

    it('emits a structured JSON decision on stdout for ask cases', async () => {
        await bootstrapWorkspace(workspace, 'work');
        const stdout = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Edit',
                tool_input: { file_path: join(workspace, 'AX_PROJECT_PLAN.md') },
            }),
            stdout,
        });
        // Exit code 0 — we hand off to upstream so it surfaces the modal.
        // Decision body uses Claude Code hook JSON output shape.
        expect(exit).toBe(0);
        const parsed = JSON.parse(stdout.text().trim());
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toMatch(/AX_PROJECT_PLAN/);
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
