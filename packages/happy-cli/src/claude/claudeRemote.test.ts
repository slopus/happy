import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeRemote } from './claudeRemote';
import { query } from '@/claude/sdk';
import type { EnhancedMode } from './loop';

vi.mock('@/claude/sdk', () => ({
    query: vi.fn(),
    AbortError: class AbortError extends Error {},
}));

const mode: EnhancedMode = {
    permissionMode: 'default',
};

describe('claudeRemote', () => {
    beforeEach(() => {
        vi.mocked(query).mockReset();
    });

    it('publishes native initialization models before a model response without forwarding account details', async () => {
        vi.mocked(query).mockReturnValue({
            initializationResult: async () => ({ models: [{ value: 'opus', displayName: 'Future Opus', supportedEffortLevels: ['high'] }], account: { email: 'private@example.com' } }),
            async *[Symbol.asyncIterator]() {},
        } as any);
        const received: unknown[] = [];
        await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/unused',
            nextMessage: async () => ({ message: 'user request', mode }), canCallTool: async () => ({ behavior: 'allow' }) as any,
            onReady: vi.fn(), isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(), onModelCatalog: catalog => received.push(catalog),
        });
        expect(received).toEqual([{ source: 'claude-native', observedAt: expect.any(Number), models: [{ code: 'opus', value: 'Future Opus', supportedEffortLevels: ['high'] }] }]);
    });

    it.each(['/clear', '/new'])('marks %s as a completed reset turn after the reset', async command => {
        const callbackOrder: string[] = [];
        const onCompletionEvent = vi.fn((message: string) => {
            callbackOrder.push(`event:${message}`);
        });
        const onSessionReset = vi.fn(() => {
            callbackOrder.push('reset');
        });
        const onReady = vi.fn(() => {
            callbackOrder.push('ready');
        });

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => ({
                message: command,
                mode,
                localIds: ['reset-input'],
            }),
            onReady,
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage: vi.fn(),
            onCompletionEvent,
            onSessionReset,
        });

        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
        expect(onSessionReset).toHaveBeenCalledOnce();
        expect(onSessionReset).toHaveBeenCalledWith(['reset-input']);
        expect(onReady).toHaveBeenCalledOnce();
        expect(callbackOrder).toEqual(['reset', 'event:Context was reset', 'ready']);
    });

    it('keeps a reset pending until its history boundary has been acknowledged', async () => {
        let acknowledge!: () => void;
        const acknowledgement = new Promise<void>(resolve => { acknowledge = resolve; });
        const onSessionReset = vi.fn(() => acknowledgement);
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        const completion = claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/unused',
            nextMessage: async () => ({ message: '/clear', mode }),
            canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
            onSessionFound: vi.fn(), onMessage: vi.fn(), onSessionReset, onReady, onCompletionEvent,
        });
        await vi.waitFor(() => expect(onSessionReset).toHaveBeenCalledOnce());
        expect(onReady).not.toHaveBeenCalled();
        expect(onCompletionEvent).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();

        acknowledge();
        await completion;
        expect(onReady).toHaveBeenCalledOnce();
        expect(onCompletionEvent).toHaveBeenCalledWith('Context was reset');
    });

    it('does not report a completed reset when its boundary could not be saved', async () => {
        const failure = new Error('metadata acknowledgement failed');
        const onReady = vi.fn();
        const onCompletionEvent = vi.fn();
        await expect(claudeRemote({
            sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/unused',
            nextMessage: async () => ({ message: '/new', mode }),
            canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false,
            onSessionFound: vi.fn(), onMessage: vi.fn(),
            onSessionReset: async () => { throw failure; }, onReady, onCompletionEvent,
        })).rejects.toBe(failure);
        expect(onReady).not.toHaveBeenCalled();
        expect(onCompletionEvent).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
    });

    it('marks assistant messages from /compact as compact summaries', async () => {
        const setPermissionMode = vi.fn();
        vi.mocked(query).mockReturnValue({
            setPermissionMode,
            initializationResult: async () => ({}),
            async *[Symbol.asyncIterator]() {
                yield {
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Long compaction summary' }],
                    },
                };
                yield {
                    type: 'result',
                    subtype: 'success',
                };
            },
        } as any);

        const onMessage = vi.fn();
        let messageCount = 0;

        await claudeRemote({
            sessionId: null,
            path: process.cwd(),
            allowedTools: [],
            hookSettingsPath: '/tmp/happy-test-settings.json',
            nextMessage: async () => {
                messageCount += 1;
                return messageCount === 1
                    ? {
                        message: '/compact',
                        mode,
                    }
                    : null;
            },
            onReady: vi.fn(),
            canCallTool: async () => ({ behavior: 'allow' }) as any,
            isAborted: () => false,
            onSessionFound: vi.fn(),
            onThinkingChange: vi.fn(),
            onMessage,
            onCompletionEvent: vi.fn(),
            onSessionReset: vi.fn(),
        });

        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
            isCompactSummary: true,
        }));
    });
});

it('marks a subsequent streamed request as thinking before the SDK consumes it', async () => {
 const transitions: boolean[] = []; let thinking = false; let messages = 0;
 vi.mocked(query).mockImplementation(({ prompt }: any) => ({
  initializationResult: async () => ({}),
  async *[Symbol.asyncIterator]() {
   const input = prompt[Symbol.asyncIterator](); await input.next();
   yield { type: 'result', subtype: 'success' };
   const second = await input.next(); expect(second.value.message.content).toBe('second');
   expect(thinking).toBe(true);
   yield { type: 'result', subtype: 'success' };
  },
 }) as any);
 await claudeRemote({ sessionId: null, path: process.cwd(), allowedTools: [], hookSettingsPath: '/tmp/settings',
  nextMessage: async () => ++messages <= 2 ? { message: messages === 1 ? 'first' : 'second', mode } : null,
  onReady: vi.fn(), canCallTool: async () => ({ behavior: 'allow' }) as any, isAborted: () => false, onSessionFound: vi.fn(), onMessage: vi.fn(),
  onThinkingChange: value => { thinking = value; transitions.push(value); },
 });
 expect(transitions).toEqual([true, false, true, false]);
});
