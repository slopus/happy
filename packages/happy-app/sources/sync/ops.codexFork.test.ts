import { beforeEach, describe, expect, it, vi } from 'vitest';

const { machineRPC, refreshSessions } = vi.hoisted(() => ({
    machineRPC: vi.fn(),
    refreshSessions: vi.fn(),
}));

vi.mock('./apiSocket', () => ({
    apiSocket: { machineRPC },
}));

vi.mock('./sync', () => ({
    sync: { refreshSessions },
}));

describe('codex fork ops', () => {
    beforeEach(() => {
        machineRPC.mockReset();
        refreshSessions.mockReset();
    });

    it('forwards effort when resuming a Happy session', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-resumed' });

        const { machineResumeSession } = await import('./ops');
        const result = await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-source',
            model: 'gpt-5.5',
            permissionMode: 'yolo',
            effort: 'xhigh',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-resumed' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                sessionId: 'happy-source',
                model: 'gpt-5.5',
                permissionMode: 'yolo',
                effort: 'xhigh',
            },
            { timeoutMs: 140_000 },
        );
    });

    it('forwards ask API environment variables when spawning a session', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-ask' });

        const { machineSpawnNewSession, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp/project',
            agent: 'ask',
            environmentVariables: {
                HAPPY_DEEPSEEK_API_KEY: 'sk-local',
                HAPPY_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
            },
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-ask' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'ask',
                environmentVariables: {
                    HAPPY_DEEPSEEK_API_KEY: 'sk-local',
                    HAPPY_DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
                },
            }),
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
    });

    it('normalizes a legacy RPC error envelope when spawning a session', async () => {
        machineRPC.mockResolvedValue({ error: 'Entrypoint does not exist' });

        const { machineSpawnNewSession } = await import('./ops');
        const result = await machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/tmp/project',
            agent: 'codex',
        });

        expect(result).toEqual({
            type: 'error',
            errorMessage: 'Entrypoint does not exist',
        });
    });

    it('normalizes a legacy RPC error envelope when resuming a session', async () => {
        machineRPC.mockResolvedValue({ error: 'Session webhook timeout after 90 seconds' });

        const { machineResumeSession } = await import('./ops');
        const result = await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-source',
        });

        expect(result).toEqual({
            type: 'error',
            errorMessage: 'Session webhook timeout after 90 seconds',
        });
    });

    it('forks a full Codex thread and spawns a Codex session resumed to the new thread', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-forked' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-forked' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-fork-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                directory: '/tmp/project',
                resumeCodexThreadId: 'thread-forked',
                parentSessionId: 'happy-source',
            }),
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it('forks Codex history into the selected next-turn working directory', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-fork-thread') {
                return { type: 'success', newCodexThreadId: 'thread-moved' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-moved' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/old-project',
            codexThreadId: 'thread-source',
        }, { targetDirectory: '/tmp/new-project' });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-moved' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-fork-thread',
            { directory: '/tmp/new-project', codexThreadId: 'thread-source' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                directory: '/tmp/new-project',
                resumeCodexThreadId: 'thread-moved',
                parentSessionId: 'happy-source',
            }),
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
    });

    it('copies Claude history into the selected directory before spawning there', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'claude-fork-session') {
                return { type: 'success', newClaudeSessionId: 'claude-moved' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-moved' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        await forkAndSpawn({
            kind: 'claude',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/old-project',
            claudeSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        }, { targetDirectory: '/tmp/new-project' });

        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'claude-fork-session',
            {
                directory: '/tmp/old-project',
                targetDirectory: '/tmp/new-project',
                claudeSessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                directory: '/tmp/new-project',
                resumeClaudeSessionId: 'claude-moved',
                parentSessionId: 'happy-source',
            }),
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
    });

    it('duplicates a Codex thread from a selected user item before spawning', async () => {
        machineRPC.mockImplementation(async (_machineId: string, method: string) => {
            if (method === 'codex-duplicate-thread') {
                return { type: 'success', newCodexThreadId: 'thread-cut' };
            }
            if (method === 'spawn-happy-session') {
                return { type: 'success', sessionId: 'happy-cut' };
            }
            throw new Error(`unexpected method ${method}`);
        });

        const { forkAndSpawn, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        const result = await forkAndSpawn({
            kind: 'codex',
            sessionId: 'happy-source',
            machineId: 'machine-1',
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
        }, {
            cutAfterItemId: 'user-item-2',
            forkedFromMessageId: 'message-2',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-cut' });
        expect(machineRPC).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            'codex-duplicate-thread',
            { directory: '/tmp/project', codexThreadId: 'thread-source', cutAfterItemId: 'user-item-2' },
        );
        expect(machineRPC).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            'spawn-happy-session',
            expect.objectContaining({
                agent: 'codex',
                resumeCodexThreadId: 'thread-cut',
                forkedFromMessageId: 'message-2',
            }),
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
    });

    it('forwards effort through the resume session RPC', async () => {
        machineRPC.mockResolvedValue({ type: 'success', sessionId: 'happy-resumed' });

        const { machineResumeSession, SESSION_START_RPC_TIMEOUT_MS } = await import('./ops');
        const result = await machineResumeSession({
            machineId: 'machine-1',
            sessionId: 'happy-source',
            model: 'gpt-5.4',
            permissionMode: 'yolo',
            effort: 'xhigh',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-resumed' });
        expect(machineRPC).toHaveBeenCalledWith(
            'machine-1',
            'resume-happy-session',
            {
                sessionId: 'happy-source',
                model: 'gpt-5.4',
                permissionMode: 'yolo',
                effort: 'xhigh',
            },
            { timeoutMs: SESSION_START_RPC_TIMEOUT_MS },
        );
    });
});
