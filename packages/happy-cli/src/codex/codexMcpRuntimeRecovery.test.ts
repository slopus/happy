import { describe, expect, it, vi } from 'vitest';

import {
    buildCodexMcpRecoveryMetadataStatuses,
    CodexMcpRuntimeRecovery,
} from './codexMcpRuntimeRecovery';

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
