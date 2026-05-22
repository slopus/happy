import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreToolUseCli } from './runPreToolUseCli';
import { bootstrapWorkspace } from '../orchestrator/state/bootstrap';
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

describe('runPreToolUseCli (no-op shim)', () => {
    it('returns 0 with no output for non-AX workspace', async () => {
        const stdout = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({ tool_name: 'Write', tool_input: { file_path: 'foo.ts', content: '' } }),
            stdout,
        });
        expect(exit).toBe(0);
        expect(stdout.text()).toBe('');
    });

    it('returns 0 regardless of step (no boundary enforcement)', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const stdout = new MemorySink();
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: stdinFor({
                tool_name: 'Write',
                tool_input: { file_path: join(workspace, 'src/app.tsx'), content: 'x' },
            }),
            stdout,
        });
        expect(exit).toBe(0);
        expect(stdout.text()).toBe('');
    });

    it('survives malformed stdin gracefully', async () => {
        const exit = await runPreToolUseCli({
            cwd: workspace,
            stdin: Readable.from(['{ this is not json']),
            stdout: new MemorySink(),
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
