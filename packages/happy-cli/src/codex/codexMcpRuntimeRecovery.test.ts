import { describe, expect, it, vi } from 'vitest';
import { createCodexTurnLatency } from './codexTurnLatency';

import {
    buildCodexMcpRecoveryMetadataStatuses,
    CodexMcpRuntimeRecovery,
} from './codexMcpRuntimeRecovery';

describe('Codex MCP same-operation status reporting', () => {
    const input = { threadId: 't', mcpServers: { notion: {} }, expectedServerNames: ['notion'], includeRuntimeStatuses: true };
    const connected = { name: 'notion', authStatus: 'unsupported', tools: {} };

    it('returns exact reportable metadata from the one healthy recovery inventory query', async () => {
        const client = { getMcpStartupStatuses: () => [], listMcpServerStatus: vi.fn(async () => ({ data: [connected] })), resumeThread: vi.fn() };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'] });
        expect(await recovery.recoverBeforeTurn(input)).toEqual({
            status: 'ready', affectedServers: [], runtimeStatuses: [{ name: 'notion', status: 'connected', checkedAt: 5 }],
        });
        expect(client.listMcpServerStatus).toHaveBeenCalledExactlyOnceWith({ threadId: 't', serverNames: ['notion'] });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('rechecks auth on the next turn and on a manual status request', async () => {
        const list = vi.fn(async () => ({ data: [connected] }));
        const client = { getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'] });
        await recovery.recoverBeforeTurn(input);
        list.mockResolvedValue({ data: [{ ...connected, authStatus: 'notLoggedIn' }] });
        expect(await recovery.recoverBeforeTurn(input)).toEqual({
            status: 'needs-auth', affectedServers: ['notion'], runtimeStatuses: [{ name: 'notion', status: 'connector-needs-auth', checkedAt: 5 }],
        });
        list.mockResolvedValue({ data: [] });
        expect(await recovery.readStatuses(input)).toEqual([{ name: 'notion', status: 'connector-runtime-failed', checkedAt: 5 }]);
        expect(list).toHaveBeenCalledTimes(3);
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('uses the final post-resume inventory rather than the initial failed snapshot', async () => {
        let status = 'failed';
        const client = {
            getMcpStartupStatuses: () => [{ name: 'notion', status }],
            listMcpServerStatus: vi.fn(async () => ({ data: [connected] })),
            resumeThread: vi.fn(async () => { status = 'ready'; return { threadId: 't', model: 'test' }; }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'], backoffMs: 0 });
        expect(await recovery.recoverBeforeTurn(input)).toEqual({
            status: 'recovered', affectedServers: ['notion'], runtimeStatuses: [{ name: 'notion', status: 'connected', checkedAt: 5 }],
        });
        expect(client.listMcpServerStatus).toHaveBeenCalledTimes(2);
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('does not reuse a snapshot taken before a failed resume', async () => {
        const client = {
            getMcpStartupStatuses: () => [{ name: 'notion', status: 'failed' }],
            listMcpServerStatus: vi.fn(async () => ({ data: [connected] })),
            resumeThread: vi.fn(async () => { throw new Error('resume failed'); }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'], maxAttempts: 1, backoffMs: 0 });
        const result = await recovery.recoverBeforeTurn(input);
        expect(result).toEqual({ status: 'failed', affectedServers: ['notion'] });
        expect(await recovery.readStatuses(input)).toEqual([{ name: 'notion', status: 'connector-runtime-failed', checkedAt: 5 }]);
        expect(client.listMcpServerStatus).toHaveBeenCalledTimes(2);
    });

    it('leaves reporting fallback fresh when the recovery inventory is unavailable', async () => {
        const list = vi.fn(async () => ({ data: [connected] })).mockRejectedValueOnce(new Error('inventory unavailable'));
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() }, { now: () => 5 });
        expect(await recovery.recoverBeforeTurn(input)).toEqual({ status: 'ready', affectedServers: [] });
        expect(await recovery.readStatuses(input)).toEqual([{ name: 'notion', status: 'connected', checkedAt: 5 }]);
        expect(list).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['starting', 'unsupported', 'reconnecting'],
        ['ready', 'notLoggedIn', 'connector-needs-auth'],
        ['cancelled', 'unsupported', 'connector-runtime-failed'],
    ] as const)('preserves %s evidence and connector qualification', async (startup, authStatus, expected) => {
        const client = { getMcpStartupStatuses: () => [{ name: 'notion', status: startup }], listMcpServerStatus: vi.fn(async () => ({ data: [{ ...connected, authStatus }] })), resumeThread: vi.fn() };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'], maxAttempts: 0 });
        const result = await recovery.recoverBeforeTurn(input);
        expect(result.runtimeStatuses).toEqual([{ name: 'notion', status: expected, checkedAt: 5 }]);
        expect(client.listMcpServerStatus).toHaveBeenCalledOnce();
    });

    it('keeps unknown auth without tools reconnecting and contains only metadata fields', async () => {
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: async () => ({ data: [{ ...connected, authStatus: 'unknown' }] }), resumeThread: vi.fn() }, { now: () => 5 });
        const result = await recovery.recoverBeforeTurn(input);
        expect(result.runtimeStatuses).toEqual([{ name: 'notion', status: 'reconnecting', checkedAt: 5 }]);
    });

    it('does not query for an empty reporting scope', async () => {
        const client = { getMcpStartupStatuses: vi.fn(() => []), listMcpServerStatus: vi.fn(async () => ({ data: [] })), resumeThread: vi.fn() };
        expect(await new CodexMcpRuntimeRecovery(client).recoverBeforeTurn({ ...input, expectedServerNames: [] })).toEqual({ status: 'ready', affectedServers: [], runtimeStatuses: [] });
        expect(client.listMcpServerStatus).not.toHaveBeenCalled();
        expect(client.getMcpStartupStatuses).not.toHaveBeenCalled();
    });

    it('shares only in-flight recovery and queries fresh after it completes', async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const list = vi.fn(async () => { await blocked; return { data: [connected] }; });
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() }, { now: () => 5 });
        const first = recovery.recoverBeforeTurn(input);
        const second = recovery.recoverBeforeTurn(input);
        expect(second).toBe(first);
        release();
        await Promise.all([first, second]);
        expect(list).toHaveBeenCalledOnce();
        await recovery.recoverBeforeTurn({ ...input, threadId: 'other-thread', mcpServers: { notion: { revision: 2 } } });
        expect(list.mock.calls).toEqual([[{ threadId: 't', serverNames: ['notion'] }], [{ threadId: 'other-thread', serverNames: ['notion'] }]]);
        await recovery.recoverBeforeTurn({ ...input, mcpServers: { notion: { revision: 3 } } });
        expect(list).toHaveBeenCalledTimes(3);
    });

    it('uses notifications received during the inventory query for reporting', async () => {
        let status = 'ready';
        const client = {
            getMcpStartupStatuses: () => [{ name: 'notion', status }],
            listMcpServerStatus: vi.fn(async () => { status = 'failed'; return { data: [connected] }; }),
            resumeThread: vi.fn(),
        };
        const result = await new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'] }).recoverBeforeTurn(input);
        expect(result.runtimeStatuses).toEqual([{ name: 'notion', status: 'connector-runtime-failed', checkedAt: 5 }]);
        expect(client.listMcpServerStatus).toHaveBeenCalledOnce();
    });

    it('does not discard the turn when only snapshot formatting loses startup evidence', async () => {
        const startup = vi.fn((): Array<{ name: string; status: string }> => []);
        startup.mockImplementationOnce(() => []).mockImplementationOnce(() => { throw new Error('notification probe failed'); });
        const list = vi.fn(async () => ({ data: [connected] }));
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: startup, listMcpServerStatus: list, resumeThread: vi.fn() }, { now: () => 5 });
        expect(await recovery.recoverBeforeTurn(input)).toEqual({ status: 'ready', affectedServers: [] });
        expect(await recovery.readStatuses(input)).toEqual([{ name: 'notion', status: 'connected', checkedAt: 5 }]);
        expect(list).toHaveBeenCalledTimes(2);
    });
});

it('does not query the entire app-server inventory when no external server needs status', async () => {
    const client = { getMcpStartupStatuses: vi.fn(() => []), listMcpServerStatus: vi.fn(async () => ({ data: [] })), resumeThread: vi.fn() };
    expect(await new CodexMcpRuntimeRecovery(client).readStatuses({ threadId: 't', mcpServers: {}, expectedServerNames: [] })).toEqual([]);
    expect(client.listMcpServerStatus).not.toHaveBeenCalled();
    expect(client.getMcpStartupStatuses).not.toHaveBeenCalled();
});

describe('buildCodexMcpRecoveryMetadataStatuses', () => {
    it('maps mixed recovery results to connector-aware wire statuses', () => {
        expect(buildCodexMcpRecoveryMetadataStatuses({
            recovery: {
                status: 'failed',
                affectedServers: ['argos', 'gmail', 'notion'],
                serverStatuses: [
                    { name: 'argos', status: 'recovered' },
                    { name: 'gmail', status: 'failed' },
                    { name: 'notion', status: 'needs-auth' },
                ],
            },
            connectorNames: ['gmail', 'notion'],
            checkedAt: 1_000,
        })).toEqual([
            { name: 'argos', status: 'connected', checkedAt: 1_000 },
            {
                name: 'gmail',
                status: 'connector-runtime-failed',
                error: 'MCP runtime initialization failed',
                checkedAt: 1_000,
            },
            {
                name: 'notion',
                status: 'connector-needs-auth',
                error: 'MCP authentication is required',
                checkedAt: 1_000,
            },
        ]);
    });

    it('uses non-connector statuses and never copies MCP configuration into metadata', () => {
        const statuses = buildCodexMcpRecoveryMetadataStatuses({
            recovery: { status: 'failed', affectedServers: ['argos'] },
            connectorNames: [],
            checkedAt: 1_000,
        });

        expect(statuses).toEqual([{
            name: 'argos',
            status: 'failed',
            error: 'MCP runtime initialization failed',
            checkedAt: 1_000,
        }]);
        expect(Object.keys(statuses[0] ?? {}).sort()).toEqual(['checkedAt', 'error', 'name', 'status']);
        const serialized = JSON.stringify(statuses).toLowerCase();
        for (const forbidden of ['url', 'header', 'token', 'grant', 'api key', 'account label']) {
            expect(serialized).not.toContain(forbidden);
        }
    });
});

describe('CodexMcpRuntimeRecovery', () => {
    it('shares one recovery sequence for concurrent calls on the same thread', async () => {
        let releaseResume!: () => void;
        const resumeBlocked = new Promise<void>((resolve) => {
            releaseResume = resolve;
        });
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                await resumeBlocked;
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { maxAttempts: 1, backoffMs: 0 });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        const first = recovery.recoverBeforeTurn(input);
        const second = recovery.recoverBeforeTurn(input);

        expect(second).toBe(first);
        await vi.waitFor(() => expect(client.resumeThread).toHaveBeenCalledOnce());
        releaseResume();
        await expect(Promise.all([first, second])).resolves.toEqual([
            { status: 'failed', affectedServers: ['argos'] },
            { status: 'failed', affectedServers: ['argos'] },
        ]);
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('recovers the same thread when an expected MCP server changes from ready to failed', async () => {
        let startupStatus: 'ready' | 'failed' = 'ready';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'ready',
            affectedServers: [],
        });

        startupStatus = 'failed';

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: 'thread-1',
            mcpServers: input.mcpServers,
            developerInstructions: input.developerInstructions,
        });
    });

    it('reports reauthentication without repeatedly resuming the thread', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{
                name: 'notion',
                status: 'failed',
                failureReason: 'reauthenticationRequired',
            }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'notion', authStatus: 'notLoggedIn', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { notion: { url: 'https://notion.test/mcp' } },
            expectedServerNames: ['notion'],
            developerInstructions: 'Use Notion through its MCP tools.',
        })).resolves.toEqual({
            status: 'needs-auth',
            affectedServers: ['notion'],
        });
        expect(client.resumeThread).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    it('retries a stale authentication failure when current inventory is logged in', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{
                name: 'notion',
                status: startupStatus,
                failureReason: startupStatus === 'failed' ? 'reauthenticationRequired' : null,
            }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'notion', authStatus: 'oAuth', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { notion: { url: 'https://notion.test/mcp' } },
            expectedServerNames: ['notion'],
        })).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['notion'],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('recovers a failed server even when another server needs authentication', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => [
                { name: 'argos', status: 'failed' },
                { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
            ]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: {} },
                    { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0, maxAttempts: 1 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        })).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'failed' },
                { name: 'notion', status: 'needs-auth' },
            ],
        });
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('reports partial recovery separately from a server that still needs authentication', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn()
                .mockReturnValueOnce([
                    { name: 'argos', status: 'failed' },
                    { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
                ])
                .mockReturnValue([
                    { name: 'argos', status: 'ready' },
                    { name: 'notion', status: 'failed', failureReason: 'reauthenticationRequired' },
                ]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                    { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0, maxAttempts: 1 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        })).resolves.toEqual({
            status: 'needs-auth',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'recovered' },
                { name: 'notion', status: 'needs-auth' },
            ],
        });
    });

    it('bounds retries and cools down a persistent runtime failure', async () => {
        let now = 1_000;
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            backoffMs: 0,
            cooldownMs: 60_000,
            now: () => now,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);

        now += 60_000;
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).toHaveBeenCalledTimes(4);
    });

    it('does not let one server cooldown hide a newly failed server on the same thread', async () => {
        let startupStatuses = [
            { name: 'argos', status: 'failed' },
            { name: 'notion', status: 'ready' },
        ];
        const client = {
            getMcpStartupStatuses: vi.fn(() => startupStatuses),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: {} },
                    { name: 'notion', authStatus: 'unsupported', tools: {} },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 1,
            backoffMs: 0,
            cooldownMs: 60_000,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        };

        await recovery.recoverBeforeTurn(input);
        await recovery.recoverBeforeTurn(input);
        expect(client.resumeThread).toHaveBeenCalledOnce();

        startupStatuses = [
            { name: 'argos', status: 'ready' },
            { name: 'notion', status: 'failed' },
        ];
        await recovery.recoverBeforeTurn(input);

        expect(client.resumeThread).toHaveBeenCalledTimes(2);
    });

    it('clears the failure cooldown after the thread reports ready', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 1,
            backoffMs: 0,
            cooldownMs: 60_000,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        await recovery.recoverBeforeTurn(input);
        await recovery.recoverBeforeTurn(input);
        expect(client.resumeThread).toHaveBeenCalledOnce();

        startupStatus = 'ready';
        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });

        startupStatus = 'failed';
        await recovery.recoverBeforeTurn(input);
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
    });

    it('returns a bounded runtime failure when resume RPCs reject', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => {
                throw new Error('resume transport failed');
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 10, sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        })).resolves.toEqual({ status: 'failed', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 10);
        expect(sleep).toHaveBeenNthCalledWith(2, 20);
    });

    it('uses the default 250ms and 500ms bounded backoff before reinspection', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'failed' }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: {} }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        })).resolves.toEqual({ status: 'failed', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenNthCalledWith(1, 250);
        expect(sleep).toHaveBeenNthCalledWith(2, 500);
    });

    it('does not restart a server that is still reporting startup progress', async () => {
        const sleep = vi.fn(async () => {});
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: 'starting' }]),
            listMcpServerStatus: vi.fn(async () => ({ data: [], nextCursor: null })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
            developerInstructions: 'Use Argos through its MCP tools.',
        })).resolves.toEqual({ status: 'ready', affectedServers: [] });
        expect(client.resumeThread).not.toHaveBeenCalled();
        expect(sleep).not.toHaveBeenCalled();
    });

    it('falls back to a structured startup failure when the inventory API is unavailable', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => {
                throw new Error('method not found');
            }),
            resumeThread: vi.fn(async () => {
                startupStatus = 'ready';
                return { threadId: 'thread-1', model: 'gpt-5.4' };
            }),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        })).resolves.toEqual({ status: 'recovered', affectedServers: ['argos'] });
        expect(client.resumeThread).toHaveBeenCalledOnce();
    });

    it('does not infer a runtime failure when neither inventory nor startup evidence is available', async () => {
        const client = {
            getMcpStartupStatuses: vi.fn(() => []),
            listMcpServerStatus: vi.fn(async () => {
                throw new Error('method not found');
            }),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { backoffMs: 0 });

        await expect(recovery.recoverBeforeTurn({
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        })).resolves.toEqual({ status: 'ready', affectedServers: [] });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('reports a previously failed server as recovered when it becomes ready before the next turn', async () => {
        let startupStatus: 'failed' | 'ready' = 'failed';
        const client = {
            getMcpStartupStatuses: vi.fn(() => [{ name: 'argos', status: startupStatus }]),
            listMcpServerStatus: vi.fn(async () => ({
                data: [{ name: 'argos', authStatus: 'unsupported', tools: { search: {} } }],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 0,
            backoffMs: 0,
            cooldownMs: 0,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: { argos: { url: 'https://argos.test/mcp' } },
            expectedServerNames: ['argos'],
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        startupStatus = 'ready';

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'recovered',
            affectedServers: ['argos'],
        });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('reports a previous recovery when a different server fails on the next turn', async () => {
        let startupStatuses = [
            { name: 'argos', status: 'failed' },
            { name: 'notion', status: 'ready' },
        ];
        const client = {
            getMcpStartupStatuses: vi.fn(() => startupStatuses),
            listMcpServerStatus: vi.fn(async () => ({
                data: [
                    { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                    { name: 'notion', authStatus: 'unsupported', tools: { search: {} } },
                ],
                nextCursor: null,
            })),
            resumeThread: vi.fn(async () => ({ threadId: 'thread-1', model: 'gpt-5.4' })),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, {
            maxAttempts: 0,
            backoffMs: 0,
            cooldownMs: 0,
        });
        const input = {
            threadId: 'thread-1',
            mcpServers: {
                argos: { url: 'https://argos.test/mcp' },
                notion: { url: 'https://notion.test/mcp' },
            },
            expectedServerNames: ['argos', 'notion'],
        };

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos'],
        });
        startupStatuses = [
            { name: 'argos', status: 'ready' },
            { name: 'notion', status: 'failed' },
        ];

        await expect(recovery.recoverBeforeTurn(input)).resolves.toEqual({
            status: 'failed',
            affectedServers: ['argos', 'notion'],
            serverStatuses: [
                { name: 'argos', status: 'recovered' },
                { name: 'notion', status: 'failed' },
            ],
        });
    });
});


describe('Codex MCP status reporting', () => {
    const input = { threadId: 'thread-1', mcpServers: {}, expectedServerNames: ['argos', 'notion'] };
    it('reports every healthy server without resuming a thread or waiting for another turn', async () => {
        const client = {
            getMcpStartupStatuses: () => [],
            listMcpServerStatus: vi.fn(async () => ({ data: [
                { name: 'argos', authStatus: 'unsupported', tools: { search: {} } },
                { name: 'notion', authStatus: 'oAuth', tools: { fetch: {} } },
            ] })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 123, connectorNames: [] });
        expect(await recovery.readStatuses(input)).toEqual([
            { name: 'argos', status: 'connected', checkedAt: 123 },
            { name: 'notion', status: 'connected', checkedAt: 123 },
        ]);
        expect(client.resumeThread).not.toHaveBeenCalled();
    });
    it('does not turn missing evidence or starting/auth-failed services green', async () => {
        const client = {
            getMcpStartupStatuses: () => [{ name: 'argos', status: 'starting' }],
            listMcpServerStatus: vi.fn(async () => ({ data: [
                { name: 'argos', authStatus: 'unsupported', tools: {} },
                { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
            ] })), resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 123, connectorNames: [] });
        expect(await recovery.readStatuses(input)).toEqual([
            { name: 'argos', status: 'reconnecting', checkedAt: 123 },
            { name: 'notion', status: 'needs-auth', checkedAt: 123 },
        ]);
        client.listMcpServerStatus.mockRejectedValue(new Error('private token'));
        expect(await recovery.readStatuses(input)).toEqual([
            { name: 'argos', status: 'reconnecting', checkedAt: 123 },
            { name: 'notion', status: 'reconnecting', checkedAt: 123 },
        ]);
    });
});


it('does not mark an empty inventory entry with unknown auth as connected', async () => {
    const recovery = new CodexMcpRuntimeRecovery({
        getMcpStartupStatuses: () => [],
        listMcpServerStatus: async () => ({ data: [{ name: 'argos', authStatus: 'unknown', tools: {} }] }),
        resumeThread: vi.fn(),
    }, { connectorNames: [] });
    expect(await recovery.readStatuses({ threadId: 't', mcpServers: {}, expectedServerNames: ['argos'] }))
        .toEqual([{ name: 'argos', status: 'reconnecting', checkedAt: expect.any(Number) }]);
});

describe('Codex MCP status reporting agrees with the recovery path', () => {
    const input = { threadId: 't', mcpServers: {}, expectedServerNames: ['notion'] };

    it('calls a settled inventory entry connected even when it publishes no tools', async () => {
        // A resource- or prompt-only server is present and authenticated. The
        // recovery path already reads this state as ready and therefore never
        // writes a correcting row, so anything but `connected` here leaves the
        // server showing as connecting for the rest of the session.
        const client = {
            getMcpStartupStatuses: () => [],
            listMcpServerStatus: vi.fn(async () => ({ data: [
                { name: 'notion', authStatus: 'unsupported', tools: {} },
            ] })),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: [] });
        expect(await recovery.readStatuses(input)).toEqual([
            { name: 'notion', status: 'connected', checkedAt: 5 },
        ]);
        expect(await recovery.recoverBeforeTurn(input)).toEqual({ status: 'ready', affectedServers: [] });
        expect(client.resumeThread).not.toHaveBeenCalled();
    });

    it('qualifies connector names the way every other publisher does', async () => {
        const client = {
            getMcpStartupStatuses: () => [],
            listMcpServerStatus: async () => ({ data: [
                { name: 'notion', authStatus: 'notLoggedIn', tools: {} },
            ] }),
            resumeThread: vi.fn(),
        };
        const recovery = new CodexMcpRuntimeRecovery(client, { now: () => 5, connectorNames: ['notion'] });
        expect(await recovery.readStatuses(input)).toEqual([
            { name: 'notion', status: 'connector-needs-auth', checkedAt: 5 },
        ]);
        expect(buildCodexMcpRecoveryMetadataStatuses({
            recovery: { status: 'needs-auth', affectedServers: ['notion'] },
            connectorNames: ['notion'],
            checkedAt: 5,
        })[0].status).toBe('connector-needs-auth');
    });

    it('reports an unknown status instead of throwing when the probe misbehaves', async () => {
        // readStatuses runs on the turn path; a rejection there is reported to
        // the user as a process crash and drops their prompt.
        const missingTools = new CodexMcpRuntimeRecovery({
            getMcpStartupStatuses: () => [],
            listMcpServerStatus: async () => ({ data: [{ name: 'notion', authStatus: 'unknown' } as never] }),
            resumeThread: vi.fn(),
        }, { now: () => 5, connectorNames: [] });
        expect(await missingTools.readStatuses(input)).toEqual([
            { name: 'notion', status: 'reconnecting', checkedAt: 5 },
        ]);

        const throwingStartup = new CodexMcpRuntimeRecovery({
            getMcpStartupStatuses: () => { throw new Error('app-server went away'); },
            listMcpServerStatus: async () => ({ data: [] }),
            resumeThread: vi.fn(),
        }, { now: () => 5, connectorNames: [] });
        expect(await throwingStartup.readStatuses(input)).toEqual([
            { name: 'notion', status: 'failed', checkedAt: 5 },
        ]);
    });
});

describe('Codex MCP recovery preparation spans', () => {
    const input = { threadId: 't', mcpServers: {}, expectedServerNames: ['notion'] };
    it('separates initial inspection, resume, backoff and post-resume verification without duplicate RPCs', async () => {
        let status = 'failed';
        const stages: string[] = [];
        const client = {
            getMcpStartupStatuses: () => [{ name: 'notion', status }],
            listMcpServerStatus: vi.fn(async () => ({ data: [{ name: 'notion', authStatus: 'unsupported', tools: {} }] })),
            resumeThread: vi.fn(async () => { status = 'ready'; return { threadId: 't', model: 'test' }; }),
        };
        const sleep = vi.fn(async () => {});
        const recovery = new CodexMcpRuntimeRecovery(client, { sleep });
        const measure = async <T>(stage: string, action: () => T | Promise<T>): Promise<T> => {
            stages.push(stage); return action();
        };
        expect(await recovery.recoverBeforeTurn({ ...input, measure })).toEqual({ status: 'recovered', affectedServers: ['notion'] });
        expect(stages).toEqual(['mcp-inventory', 'mcp-reconnect', 'mcp-backoff', 'mcp-verification']);
        expect(client.listMcpServerStatus).toHaveBeenCalledTimes(2);
        expect(client.resumeThread).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
    });
    it.each(['before', 'after'] as const)('contains a diagnostic failure %s execution and invokes inventory once', async where => {
        const list = vi.fn(async () => ({ data: [{ name: 'notion', authStatus: 'unsupported', tools: {} }] }));
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() });
        const measure = async <T>(_stage: string, action: () => T | Promise<T>): Promise<T> => {
            if (where === 'after') await action();
            throw new Error('diagnostic failure');
        };
        expect(await recovery.recoverBeforeTurn({ ...input, measure })).toEqual({ status: 'ready', affectedServers: [] });
        expect(list).toHaveBeenCalledOnce();
    });
    it('reports measured inventory duration inside the overlapping recovery parent', async () => {
        let clock = 0;
        const emit = vi.fn();
        const recorder = createCodexTurnLatency({ inputCount: 1, latencyTraces: [{ id: 'trace', receivedAt: 0 }] }, emit, () => clock)!;
        const list = vi.fn(async () => { clock += 37; return { data: [{ name: 'notion', authStatus: 'unsupported', tools: {} }] }; });
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() });
        await recorder.measure('mcp-recovery', () => recovery.recoverBeforeTurn({ ...input, measure: recorder.measure }));
        expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ preparation: [
            { stage: 'mcp-recovery', startedMs: 0, durationMs: 37, outcome: 'resolved' },
            { stage: 'mcp-inventory', startedMs: 0, durationMs: 37, outcome: 'resolved' },
        ] }));
        expect(list).toHaveBeenCalledOnce();
    });
    it('does not retry a failed resume twice when diagnostics swallow or repeat the operation', async () => {
        const resume = vi.fn(async () => { throw new Error('provider failure'); });
        const list = vi.fn(async () => ({ data: [] }));
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: resume }, { maxAttempts: 1, backoffMs: 0 });
        const measure = async <T>(_stage: string, action: () => T | Promise<T>): Promise<T | undefined> => {
            try { await action(); return await action(); } catch { return undefined; }
        };
        const result = await recovery.recoverBeforeTurn({ ...input, measure: <T>(stage: string, action: () => T | Promise<T>) => measure(stage, action) as Promise<T> });
        expect(result).toEqual({ status: 'failed', affectedServers: ['notion'] });
        expect(list).toHaveBeenCalledOnce();
        expect(resume).toHaveBeenCalledOnce();
    });
    it('records a shared in-flight inspection only for its initiating input', async () => {
        let release!: () => void;
        const wait = new Promise<void>(resolve => { release = resolve; });
        const list = vi.fn(async () => { await wait; return { data: [{ name: 'notion', authStatus: 'unsupported', tools: {} }] }; });
        const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() });
        const stages: string[] = [];
        const measure = async <T>(stage: string, action: () => T | Promise<T>): Promise<T> => { stages.push(stage); return action(); };
        const joined = vi.fn();
        const first = recovery.recoverBeforeTurn({ ...input, expectedServerNames: [], measure });
        await first;
        expect(stages).toEqual([]);
        const owner = recovery.recoverBeforeTurn({ ...input, measure });
        const second = recovery.recoverBeforeTurn({ ...input, measure: <T>(stage: string, action: () => T | Promise<T>) => { joined(stage, action); return action(); } });
        expect(second).toBe(owner);
        release(); await owner;
        expect(stages).toEqual(['mcp-inventory']);
        expect(joined).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledOnce();
    });
});

it.each(['failed', 'cancelled', 'disabled', 'starting', 'notStarted', 'authenticationRequired'])('does not call %s runtime evidence connected despite settled auth', async runtimeStatus => {
    const list = vi.fn(async () => ({ data: [{ name: 'probe', authStatus: 'unsupported', tools: { probe: {} }, runtimeStatus }] }));
    const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() }, { connectorNames: [] });
    const input = { threadId: 'thread-1', mcpServers: {}, expectedServerNames: ['probe'] };
    const statuses = await recovery.readStatuses(input);
    expect(list).toHaveBeenCalledWith({ threadId: 'thread-1', serverNames: ['probe'] });
    expect(statuses[0].status).toBe(runtimeStatus === 'authenticationRequired' ? 'needs-auth' : ['failed', 'cancelled', 'disabled'].includes(runtimeStatus) ? 'failed' : 'reconnecting');
});

it('recovers failed runtime even without a startup failure and rechecks the resumed runtime', async () => {
    const list = vi.fn().mockResolvedValueOnce({ data: [{ name: 'probe', authStatus: 'unsupported', tools: {}, runtimeStatus: 'failed' }] }).mockResolvedValueOnce({ data: [{ name: 'probe', authStatus: 'unsupported', tools: {}, runtimeStatus: 'connected' }] });
    const resume = vi.fn(async () => ({ threadId: 't', model: 'model' }));
    const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: resume }, { connectorNames: [], sleep: async () => {} });
    const result = await recovery.recoverBeforeTurn({ threadId: 't', mcpServers: { probe: {} }, expectedServerNames: ['probe'], includeRuntimeStatuses: true });
    expect(result.status).toBe('recovered');
    expect(result.runtimeStatuses?.[0].status).toBe('connected');
    expect(resume).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledTimes(2);
});

it('forwards opt-in server measurement through the owning inventory operation only', async () => {
    const stages: string[] = [];
    const action = vi.fn(async () => ({ data: [{ name: 'probe', authStatus: 'unsupported', tools: {} }] }));
    const list = vi.fn(async (opts: { measureServer?: <T>(action: () => Promise<T>) => Promise<T> }) => opts.measureServer ? opts.measureServer(action) : action());
    const recovery = new CodexMcpRuntimeRecovery({ getMcpStartupStatuses: () => [], listMcpServerStatus: list, resumeThread: vi.fn() }, { connectorNames: [] });
    await recovery.recoverBeforeTurn({ threadId: 't', mcpServers: {}, expectedServerNames: ['probe'], measure: async (stage, execute) => { stages.push(stage); return execute(); } });
    expect(stages).toEqual(['mcp-inventory', 'mcp-inventory-server']);
    expect(action).toHaveBeenCalledOnce();
    await recovery.recoverBeforeTurn({ threadId: 't', mcpServers: {}, expectedServerNames: ['probe'] });
    expect(list.mock.calls[1][0]).not.toHaveProperty('measureServer');
});
