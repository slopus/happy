import { describe, expect, it, vi } from 'vitest';

import { resumeExistingThread } from './resumeExistingThread';

describe('resumeExistingThread', () => {
    it('resumes the thread and updates session metadata', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                model: 'gpt-5.4',
                reasoningEffort: 'xhigh',
            }),
            readThread: vi.fn().mockResolvedValue({
                thread: {
                    turns: [{
                        id: 'turn-1',
                        status: 'completed',
                        items: [{
                            type: 'userMessage',
                            id: 'item-1',
                            content: [{ type: 'text', text: 'Existing desktop message' }],
                        }],
                    }],
                },
            }),
        };
        let metadata: any = { existing: true };
        const session = {
            sessionId: 'paws-session-1',
            getMetadata: vi.fn(() => metadata),
            updateMetadata: vi.fn((handler) => {
                metadata = handler(metadata);
            }),
            updateMetadataAndAwait: vi.fn(async (handler) => {
                metadata = handler(metadata);
            }),
            flushOutboxAndAwait: vi.fn(async () => {}),
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer,
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });

        expect(result).toEqual({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            model: 'gpt-5.4',
            reasoningEffort: 'xhigh',
            activeTurnId: null,
        });
        expect(client.resumeThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            cwd: '/tmp/project',
            mcpServers: { happy: { command: 'happy-mcp' } },
        });
        expect(metadata).toEqual({
            existing: true,
            codexThreadId: '019ccca2-1a77-7481-9873-de72f3464372',
            codexSyncCursor: {
                threadId: '019ccca2-1a77-7481-9873-de72f3464372',
                turnId: 'turn-1',
            },
        });
        expect(client.readThread).toHaveBeenCalledWith({
            threadId: '019ccca2-1a77-7481-9873-de72f3464372',
            includeTurns: true,
        });
        expect(session.sendSessionProtocolMessage).toHaveBeenCalledWith(expect.objectContaining({
            role: 'user',
            ev: expect.objectContaining({
                t: 'text',
                text: 'Existing desktop message',
            }),
        }));
        expect(session.flushOutboxAndAwait).toHaveBeenCalledTimes(1);
        expect(session.updateMetadataAndAwait).toHaveBeenCalledTimes(1);
        expect(session.flushOutboxAndAwait.mock.invocationCallOrder[0])
            .toBeLessThan(session.updateMetadataAndAwait.mock.invocationCallOrder[0]);
        expect(messageBuffer.addMessage).toHaveBeenCalledWith(expect.stringContaining('Resumed thread'), 'status');
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Resumed Codex thread 019ccca2-1a77-7481-9873-de72f3464372',
        });
    });

    it('wraps backend resume errors with the thread ID', async () => {
        const client = {
            resumeThread: vi.fn().mockRejectedValue(new Error('thread not found')),
            readThread: vi.fn(),
        };
        const session = {
            sessionId: 'paws-session-1',
            getMetadata: vi.fn(() => null),
            updateMetadata: vi.fn(),
            updateMetadataAndAwait: vi.fn(async () => {}),
            flushOutboxAndAwait: vi.fn(async () => {}),
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };
        const messageBuffer = {
            addMessage: vi.fn(),
        };

        await expect(
            resumeExistingThread({
                client,
                session,
                messageBuffer,
                threadId: 'thread-404',
                cwd: '/tmp/project',
                mcpServers: {},
            }),
        ).rejects.toThrow('Failed to resume Codex thread thread-404: thread not found');
    });

    it('does not replay history for a legacy reconnect without a sync cursor', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: 'thread-reconnect-1',
                model: 'gpt-5.6-sol',
                reasoningEffort: 'high',
            }),
            readThread: vi.fn().mockResolvedValue({
                thread: {
                    turns: [
                        {
                            id: 'turn-existing',
                            status: 'completed',
                            items: [{
                                type: 'userMessage',
                                id: 'user-existing',
                                content: [{ type: 'text', text: 'already mirrored' }],
                            }],
                        },
                        {
                            id: 'turn-active',
                            status: 'inProgress',
                            items: [],
                        },
                    ],
                },
            }),
        };
        const session = {
            sessionId: 'paws-session-1',
            getMetadata: vi.fn(() => ({ codexThreadId: 'thread-reconnect-1' })),
            updateMetadata: vi.fn(),
            updateMetadataAndAwait: vi.fn(async () => {}),
            flushOutboxAndAwait: vi.fn(async () => {}),
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer: { addMessage: vi.fn() },
            threadId: 'thread-reconnect-1',
            cwd: '/tmp/project',
            mcpServers: {},
            historyMode: 'after-cursor',
        });

        expect(client.readThread).toHaveBeenCalledWith({
            threadId: 'thread-reconnect-1',
            includeTurns: true,
        });
        expect(session.sendSessionProtocolMessage).not.toHaveBeenCalled();
        expect(result.activeTurnId).toBe('turn-active');
    });

    it('replays only turns completed after the reconnect cursor', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: 'thread-reconnect-2',
                model: 'gpt-5.6-sol',
                reasoningEffort: 'high',
            }),
            readThread: vi.fn().mockResolvedValue({
                thread: {
                    turns: [
                        {
                            id: 'turn-already-mirrored',
                            items: [{
                                type: 'userMessage',
                                id: 'user-old',
                                content: [{ type: 'text', text: 'old message' }],
                            }],
                        },
                        {
                            id: 'turn-while-disconnected',
                            status: 'completed',
                            items: [
                                {
                                    type: 'userMessage',
                                    id: 'user-new',
                                    content: [{ type: 'text', text: 'new desktop message' }],
                                },
                                {
                                    type: 'agentMessage',
                                    id: 'agent-new',
                                    text: 'new desktop response',
                                    phase: 'final_answer',
                                },
                                {
                                    type: 'reasoning',
                                    id: 'reasoning-new',
                                    summary: ['transient reasoning'],
                                    content: [],
                                },
                                {
                                    type: 'commandExecution',
                                    id: 'command-new',
                                    command: 'pwd',
                                    aggregatedOutput: '/tmp/project',
                                },
                            ],
                        },
                        {
                            id: 'turn-still-running',
                            status: 'inProgress',
                            items: [
                                {
                                    type: 'userMessage',
                                    id: 'user-running',
                                    content: [{ type: 'text', text: 'desktop turn still running' }],
                                },
                                {
                                    type: 'agentMessage',
                                    id: 'agent-running-partial',
                                    text: 'partial answer',
                                },
                            ],
                        },
                    ],
                },
            }),
        };
        let metadata: any = {
            codexThreadId: 'thread-reconnect-2',
            codexSyncCursor: {
                threadId: 'thread-reconnect-2',
                turnId: 'turn-already-mirrored',
            },
        };
        const session = {
            sessionId: 'paws-session-1',
            getMetadata: vi.fn(() => metadata),
            updateMetadata: vi.fn((handler) => {
                metadata = handler(metadata);
            }),
            updateMetadataAndAwait: vi.fn(async (handler) => {
                metadata = handler(metadata);
            }),
            flushOutboxAndAwait: vi.fn(async () => {}),
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };

        const result = await resumeExistingThread({
            client,
            session,
            messageBuffer: { addMessage: vi.fn() },
            threadId: 'thread-reconnect-2',
            cwd: '/tmp/project',
            mcpServers: {},
            historyMode: 'after-cursor',
        });

        const mirrored = session.sendSessionProtocolMessage.mock.calls.map(([envelope]) => envelope);
        expect(mirrored).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', ev: expect.objectContaining({ text: 'new desktop message' }) }),
            expect.objectContaining({ role: 'agent', ev: expect.objectContaining({ text: 'new desktop response' }) }),
        ]));
        expect(mirrored).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', ev: expect.objectContaining({ text: 'old message' }) }),
        ]));
        expect(mirrored).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: 'user', ev: expect.objectContaining({ text: 'desktop turn still running' }) }),
        ]));
        expect(mirrored.some((envelope) => envelope.ev.t === 'text' && envelope.ev.text === 'partial answer')).toBe(false);
        expect(mirrored.some((envelope) => envelope.id === 'turn-still-running:end')).toBe(false);
        expect(mirrored.some((envelope) => envelope.ev.t === 'tool-call-start')).toBe(false);
        expect(mirrored.some((envelope) => envelope.ev.t === 'text' && envelope.ev.thinking === true)).toBe(false);
        expect(metadata.codexSyncCursor).toEqual({
            threadId: 'thread-reconnect-2',
            turnId: 'turn-while-disconnected',
        });
        expect(result.activeTurnId).toBe('turn-still-running');
    });

    it('does not advance the cursor when replay delivery is not acknowledged', async () => {
        const client = {
            resumeThread: vi.fn().mockResolvedValue({
                threadId: 'thread-reconnect-3',
                model: 'gpt-5.6-sol',
                reasoningEffort: 'high',
            }),
            readThread: vi.fn().mockResolvedValue({
                thread: {
                    turns: [{
                        id: 'turn-after-cursor',
                        items: [{
                            type: 'agentMessage',
                            id: 'agent-after-cursor',
                            text: 'reply while disconnected',
                        }],
                    }],
                },
            }),
        };
        const session = {
            sessionId: 'paws-session-1',
            getMetadata: vi.fn(() => ({
                codexSyncCursor: { threadId: 'thread-reconnect-3', turnId: 'missing-old-turn' },
            })),
            updateMetadata: vi.fn(),
            updateMetadataAndAwait: vi.fn(async () => {}),
            flushOutboxAndAwait: vi.fn(async () => {
                throw new Error('relay unavailable');
            }),
            sendSessionEvent: vi.fn(),
            sendSessionProtocolMessage: vi.fn(),
        };

        await expect(resumeExistingThread({
            client,
            session,
            messageBuffer: { addMessage: vi.fn() },
            threadId: 'thread-reconnect-3',
            cwd: '/tmp/project',
            mcpServers: {},
            historyMode: 'full',
        })).rejects.toThrow('relay unavailable');

        expect(session.updateMetadataAndAwait).not.toHaveBeenCalled();
    });
});
