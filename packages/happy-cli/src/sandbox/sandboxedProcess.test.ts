import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSandboxedProcess } from './sandboxedProcess';

const { mockWrapCommand } = vi.hoisted(() => ({ mockWrapCommand: vi.fn() }));

vi.mock('./manager', () => ({ wrapCommand: mockWrapCommand }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve) => {
        let text = '';
        stream.on('data', (chunk) => { text += chunk.toString(); });
        stream.on('end', () => resolve(text));
    });
}

function exitOf(child: ReturnType<typeof spawnSandboxedProcess>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

describe('spawnSandboxedProcess', () => {
    beforeEach(() => {
        mockWrapCommand.mockReset();
    });

    it('runs the quoted command line through the sandbox wrapper', async () => {
        // The "sandbox" here is a shell that prints what it was asked to run.
        mockWrapCommand.mockImplementation(async (command: string) => `printf '%s' ${JSON.stringify(command)}`);
        const child = spawnSandboxedProcess({ signal: new AbortController().signal, command: '/opt/claude', args: ['--flag', "it's here"], env: {} });
        const [out, exit] = await Promise.all([readAll(child.stdout), exitOf(child)]);
        expect(mockWrapCommand).toHaveBeenCalledWith(`'/opt/claude' '--flag' 'it'\\''s here'`);
        expect(out).toBe(`'/opt/claude' '--flag' 'it'\\''s here'`);
        expect(exit).toEqual({ code: 0, signal: null });
        expect(child.exitCode).toBe(0);
    });

    it('connects stdin and stdout to the wrapped process', async () => {
        mockWrapCommand.mockResolvedValue('cat');
        const child = spawnSandboxedProcess({ signal: new AbortController().signal, command: 'claude', args: [], env: { PATH: process.env.PATH } });
        const output = readAll(child.stdout);
        const exit = exitOf(child);
        child.stdin.write('{"type":"user"}\n');
        child.stdin.end();
        expect(await output).toBe('{"type":"user"}\n');
        expect((await exit).code).toBe(0);
    });

    it('passes the working folder and environment to the wrapped process', async () => {
        mockWrapCommand.mockResolvedValue('printf "%s %s" "$PWD" "$SANDBOX_TEST_VAR"');
        const child = spawnSandboxedProcess({ signal: new AbortController().signal, command: 'claude', args: [], cwd: '/tmp', env: { SANDBOX_TEST_VAR: 'set', PATH: process.env.PATH } });
        expect(await readAll(child.stdout)).toBe('/tmp set');
    });

    it('kills the process even when asked before it has started', async () => {
        mockWrapCommand.mockResolvedValue('sleep 30');
        const child = spawnSandboxedProcess({ signal: new AbortController().signal, command: 'claude', args: [], env: { PATH: process.env.PATH } });
        expect(child.kill('SIGTERM')).toBe(true);
        expect(child.killed).toBe(true);
        const exit = await exitOf(child);
        expect(exit.signal).toBe('SIGTERM');
    });

    it('reports a sandbox that cannot wrap the command as an error and an exit', async () => {
        mockWrapCommand.mockRejectedValue(new Error('bwrap missing'));
        const child = spawnSandboxedProcess({ signal: new AbortController().signal, command: 'claude', args: [], env: {} });
        const error = new Promise<Error>((resolve) => child.once('error', resolve));
        const exit = exitOf(child);
        expect((await error).message).toContain('bwrap missing');
        expect((await exit).code).toBe(1);
    });
});
