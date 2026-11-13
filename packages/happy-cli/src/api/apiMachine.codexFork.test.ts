import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configuration } from '@/configuration';
import { retainCodexAccountHistory, rememberCodexAccountSession } from '@/codex/codexAccountHistory';

const { codexClientMethods } = vi.hoisted(() => ({
    codexClientMethods: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        deleteThread: vi.fn(),
        forkThread: vi.fn(),
        readThread: vi.fn(),
        rollbackThread: vi.fn(),
        injectItems: vi.fn(),
    },
}));

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: vi.fn().mockImplementation(() => codexClientMethods),
}));

import { ApiMachineClient } from './apiMachine';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

describe('ApiMachineClient Codex fork RPCs', () => {
    let root: string;
    const savedHappyHome = configuration.happyHomeDir;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'codex-fork-rpc-test-'));
        (configuration as { happyHomeDir: string }).happyHomeDir = root;
        const source = join(root, 'native'); await mkdir(join(source, 'sessions'), { recursive: true });
        for (const id of ['thread-source', 'thread-desktop', 'thread-takeover-fork']) await writeFile(join(source, 'sessions', `rollout-${id}.jsonl`), 'native-thread');
        await retainCodexAccountHistory(join(root, 'codex-session-cache'), 'profile-a', source);
        await rememberCodexAccountSession(join(root, 'codex-session-cache'), 'source-session', 'profile-a');
        for (const method of Object.values(codexClientMethods)) {
            method.mockReset();
        }
        codexClientMethods.connect.mockResolvedValue(undefined);
        codexClientMethods.disconnect.mockResolvedValue(undefined);
    });
    afterEach(async () => { (configuration as { happyHomeDir: string }).happyHomeDir = savedHappyHome; await rm(root, { recursive: true, force: true }); });

    it('registers a full Codex thread fork RPC', async () => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: { id: 'thread-forked', turns: [] },
        });

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-fork-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
            sourceSessionId: 'source-session',
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.connect).toHaveBeenCalledOnce();
        expect(codexClientMethods.forkThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            cwd: '/tmp/project',
            deferGoalContinuation: true,
        });
        expect(codexClientMethods.disconnect).toHaveBeenCalledOnce();
    });

    it('forwards resumeCodexThreadId through the spawn RPC', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-forked' });

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
            codexSessionGrant: 'grant-for-fork',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-forked' });
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/project',
            agent: 'codex',
            resumeCodexThreadId: 'thread-forked',
            parentSessionId: 'happy-source',
            codexSessionGrant: 'grant-for-fork',
        }));
    });

    it('returns spawn failures as a typed RPC result', async () => {
        const spawnSession = vi.fn().mockResolvedValue({
            type: 'error',
            errorMessage: 'Entrypoint does not exist',
        });

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:spawn-happy-session')?.({
            directory: '/tmp/project',
            agent: 'codex',
        });

        expect(result).toEqual({
            type: 'error',
            errorMessage: 'Entrypoint does not exist',
        });
    });

    it('forwards effort through the resume RPC', async () => {
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-resumed' });

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            resumeSession,
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:resume-happy-session')?.({
            sessionId: 'happy-source',
            model: 'gpt-5.5',
            permissionMode: 'yolo',
            effort: 'xhigh',
            codexSessionGrant: 'grant-for-resume',
        });

        expect(result).toEqual({ type: 'success', sessionId: 'happy-resumed' });
        expect(resumeSession).toHaveBeenCalledWith('happy-source', {
            model: 'gpt-5.5',
            permissionMode: 'yolo',
            effort: 'xhigh',
            codexSessionGrant: 'grant-for-resume',
        });
    });

    it('lists Codex rewind points from thread/read', async () => {
        codexClientMethods.readThread.mockResolvedValue({
            thread: {
                id: 'thread-source',
                turns: [{
                    id: 'turn-1',
                    startedAt: 10,
                    items: [
                        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
                    ],
                }],
            },
        });

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-list-rewind-points')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
            sourceSessionId: 'source-session',
        });

        expect(result).toEqual({
            type: 'success',
            points: [{ itemId: 'user-1', text: 'hello', timestamp: 10_000 }],
        });
        expect(codexClientMethods.readThread).toHaveBeenCalledWith({
            threadId: 'thread-source',
            includeTurns: true,
        });
    });

    it.each([
        { boundary: { cutAfterItemId: 'user-1', retainSelectedTurn: true }, native: { lastTurnId: 'turn-1' } },
        { boundary: { cutBeforeItemId: 'user-2' }, native: { beforeTurnId: 'turn-2' } },
    ])('preserves the agent response with boundary $boundary', async ({ boundary, native }) => {
        codexClientMethods.forkThread.mockResolvedValue({
            threadId: 'thread-forked',
            thread: {
                id: 'thread-forked',
                turns: [
                    { id: 'turn-1', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'one' }] }] },
                    { id: 'turn-2', items: [{ id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'two' }] }] },
                ],
            },
        });
        codexClientMethods.rollbackThread.mockResolvedValue({ thread: { id: 'thread-forked', turns: [] } });
        codexClientMethods.readThread.mockResolvedValueOnce({
            thread: { id: 'thread-source', turns: [
                { id: 'turn-1', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'one' }] }] },
                { id: 'turn-2', items: [{ id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: 'two' }] }] },
            ] },
        }).mockResolvedValueOnce({ thread: { id: 'thread-forked', turns: [{ id: 'turn-1', items: [] }] } });
        codexClientMethods.injectItems.mockResolvedValue({});

        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({
            spawnSession: vi.fn(),
            stopSession: vi.fn(),
            requestShutdown: vi.fn(),
        });

        const result = await handlersFrom(client).get('machine-1:codex-duplicate-thread')?.({
            directory: '/tmp/project',
            codexThreadId: 'thread-source',
            sourceSessionId: 'source-session',
            ...boundary,
        });

        expect(result).toEqual({ type: 'success', newCodexThreadId: 'thread-forked' });
        expect(codexClientMethods.forkThread).toHaveBeenCalledWith({ threadId: 'thread-source', cwd: '/tmp/project', ...native, deferGoalContinuation: true });
        expect(codexClientMethods.rollbackThread).not.toHaveBeenCalled();
        expect(codexClientMethods.injectItems).not.toHaveBeenCalled();
    });
    it.each(['codex-fork-thread', 'codex-duplicate-thread', 'codex-list-rewind-points'])('rejects unmapped native history before opening app-server (%s)', async method => {
        const client = new ApiMachineClient('token', machineClient());
        client.setRPCHandlers({ spawnSession: vi.fn(), stopSession: vi.fn(), requestShutdown: vi.fn() });
        await expect(handlersFrom(client).get(`machine-1:${method}`)?.({ directory: '/tmp/project', codexThreadId: 'thread-source', cutAfterItemId: 'user-1', sourceSessionId: 'legacy-unmapped' })).rejects.toThrow('unavailable');
        expect(codexClientMethods.connect).not.toHaveBeenCalled();
    });
});
