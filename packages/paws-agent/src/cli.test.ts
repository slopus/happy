import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PawsAgentClient } from './client/PawsAgentClient';
import type { Session } from './client/types';
import { isIdle, runCli, type CliDependencies } from './cli';

const session: Session = {
    id: 'session-1', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
    metadata: {}, metadataVersion: 1, agentState: {}, agentStateVersion: 1,
};

afterEach(() => {
    process.exitCode = undefined;
});

describe('thin CLI', () => {
    it('treats a running turn as busy and a completed turn as idle', () => {
        expect(isIdle({
            ...session,
            agentState: { turnStatus: { status: 'running' }, requests: {} },
        })).toBe(false);
        expect(isIdle({
            ...session,
            agentState: { turnStatus: { status: 'completed' }, requests: {} },
        })).toBe(true);
    });

    it('delegates send to the public SDK and keeps JSON on stdout', async () => {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const send = vi.fn().mockResolvedValue({ sessionId: 'session-1', localId: 'local-1' });
        const client = {
            sessions: { list: vi.fn().mockResolvedValue([session]) },
            messages: { send },
            dispose: vi.fn(),
        } as unknown as PawsAgentClient;
        const dependencies: CliDependencies = {
            client,
            auth: { login: vi.fn(), logout: vi.fn(), status: vi.fn() },
            stdout: value => stdout.push(value),
            stderr: value => stderr.push(value),
        };

        await runCli(['node', 'paws-agent', 'send', 'session-1', 'hello', '--json'], dependencies);

        expect(send).toHaveBeenCalledWith({
            sessionId: 'session-1',
            text: 'hello',
            meta: undefined,
        });
        expect(JSON.parse(stdout.join(''))).toEqual({ sessionId: 'session-1', localId: 'local-1' });
        expect(stderr).toEqual([]);
    });

    it.each([
        ['spawn', '--machine', 'machine-1', '--agent', 'invalid-agent'],
        ['history', 'session-1', '--limit', '0'],
    ])('returns exit code 2 for invalid usage: %s', async (...args: string[]) => {
        const dependencies: CliDependencies = {
            client: { dispose: vi.fn() } as unknown as PawsAgentClient,
            auth: { login: vi.fn(), logout: vi.fn(), status: vi.fn() },
            stdout: vi.fn(),
            stderr: vi.fn(),
        };

        await runCli(['node', 'paws-agent', ...args], dependencies);

        expect(process.exitCode).toBe(2);
    });
});
