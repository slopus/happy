import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { AbortError, query } from '@/claude/sdk';
import type { SDKMessage } from '@/claude/sdk';

vi.mock('@/claude/sdk', async () => {
    class AbortError extends Error {}
    return {
        query: vi.fn(),
        AbortError
    };
});

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/claude/utils/systemPrompt', () => ({
    systemPrompt: ''
}));

vi.mock('@/claude/utils/claudeCheckSession', () => ({
    claudeCheckSession: () => true
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: async () => true
}));

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockResponse(messages: Array<{ message: SDKMessage, delayMs?: number }>) {
    async function* iterate() {
        for (const item of messages) {
            if (item.delayMs) {
                await sleep(item.delayMs);
            }
            yield item.message;
        }
    }

    return {
        [Symbol.asyncIterator]() {
            return iterate();
        },
        interrupt: vi.fn(async () => undefined)
    };
}

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('keeps consuming SDK output while waiting for the next user message after result', async () => {
        const lateAssistant: SDKMessage = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'late assistant message' }]
            }
        };

        vi.mocked(query).mockReturnValue(
            createMockResponse([
                {
                    message: {
                        type: 'result',
                        subtype: 'success',
                        num_turns: 1,
                        total_cost_usd: 0,
                        duration_ms: 1,
                        duration_api_ms: 1,
                        is_error: false,
                        session_id: 'session-1'
                    } as SDKMessage
                },
                { message: lateAssistant, delayMs: 10 }
            ]) as any
        );

        let resolveSecondNextMessage: (value: any) => void = () => undefined;
        const secondNextMessage = new Promise<any>((resolve) => {
            resolveSecondNextMessage = resolve;
        });

        const onMessage = vi.fn();
        let nextMessageCalls = 0;

        const remotePromise = claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/fake-settings.json',
            nextMessage: async () => {
                nextMessageCalls += 1;
                if (nextMessageCalls === 1) {
                    return {
                        message: 'hello',
                        mode: { permissionMode: 'default' }
                    };
                }
                if (nextMessageCalls === 2) {
                    return secondNextMessage;
                }
                return null;
            },
            onReady: vi.fn(),
            isAborted: () => false,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onSessionFound: vi.fn(),
            onMessage,
            signal: new AbortController().signal
        });

        await sleep(30);
        expect(onMessage).toHaveBeenCalledWith(lateAssistant);

        resolveSecondNextMessage(null);
        await remotePromise;
    });

    it('does not auto-interrupt at tool_result boundaries', async () => {
        const response = createMockResponse([
            {
                message: {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'working' }]
                    }
                } as SDKMessage
            },
            {
                message: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 'tool-1',
                                content: [{ type: 'text', text: 'ok' }],
                            } as any
                        ]
                    }
                } as SDKMessage
            }
        ]);
        vi.mocked(query).mockReturnValue(response as any);

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/fake-settings.json',
            nextMessage: async () => ({
                message: 'hello',
                mode: { permissionMode: 'default' }
            }),
            onReady: vi.fn(),
            isAborted: () => false,
            canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
            onSessionFound: vi.fn(),
            onMessage: vi.fn(),
            signal: new AbortController().signal,
        });

        expect(response.interrupt).not.toHaveBeenCalled();
    });

    it('still exits cleanly on explicit AbortError', async () => {
        const response = {
            async *[Symbol.asyncIterator]() {
                throw new AbortError('aborted');
            },
            interrupt: vi.fn(async () => undefined),
        };
        vi.mocked(query).mockReturnValue(response as any);

        await expect(
            claudeRemote({
                sessionId: null,
                path: process.cwd(),
                allowedTools: [],
                hookSettingsPath: '/tmp/fake-settings.json',
                nextMessage: async () => ({
                    message: 'hello',
                    mode: { permissionMode: 'default' }
                }),
                onReady: vi.fn(),
                isAborted: () => false,
                canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
                onSessionFound: vi.fn(),
                onMessage: vi.fn(),
                signal: new AbortController().signal,
            })
        ).resolves.toBeUndefined();
    });
});
