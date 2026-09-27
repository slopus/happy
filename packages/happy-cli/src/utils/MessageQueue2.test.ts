import { describe, it, expect, vi } from 'vitest';
import { MessageQueue2 } from './MessageQueue2';
import { hashObject } from './deterministicJson';

describe('MessageQueue2', () => {
    it.each([false, true])('claims synchronously before removing a batch (waiting=%s)', async (waiting) => {
        const queue = new MessageQueue2<string>(mode => mode);
        const claim = vi.fn(() => { expect(queue.size()).toBe(1); return true; });
        if (!waiting) queue.push('owned input', 'local');
        const result = queue.waitForMessagesAndGetAsString(undefined, claim);
        if (waiting) queue.push('owned input', 'local');
        await Promise.resolve();
        expect(claim).toHaveBeenCalledOnce();
        expect((await result)?.message).toBe('owned input');
    });
    it('preserves an unclaimed batch and its attachments', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        const attachments = [{ data: new Uint8Array([1]), mimeType: 'image/png', name: 'test.png' }];
        queue.pushIsolated('/clear', 'local', attachments);
        expect(await queue.waitForMessagesAndGetAsString(undefined, () => false)).toBeNull();
        expect(queue.size()).toBe(1);
        expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({ message: '/clear', attachments });
    });
    it('should create a queue', () => {
        const queue = new MessageQueue2<string>(mode => mode);
        expect(queue.size()).toBe(0);
        expect(queue.isClosed()).toBe(false);
    });

    it('should push and retrieve messages with same mode', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        queue.push('message1', 'local');
        queue.push('message2', 'local');
        queue.push('message3', 'local');
        
        const result = await queue.waitForMessagesAndGetAsString();
        expect(result).not.toBeNull();
        expect(result?.message).toBe('message1\nmessage2\nmessage3');
        expect(result?.mode).toBe('local');
        expect(queue.size()).toBe(0);
    });

    it('keeps opt-in latency trace ids for every input coalesced into one batch', async () => {
        const queue = new MessageQueue2<string>(mode => mode);

        queue.push('message1', 'local', undefined, ['request-1'], { id: 'trace-1', receivedAt: 10 });
        queue.push('message2', 'local', undefined, ['request-2'], { id: 'trace-2', receivedAt: 20 });

        await expect(queue.waitForMessagesAndGetAsString()).resolves.toEqual(expect.objectContaining({
            message: 'message1\nmessage2',
            inputCount: 2,
            requestIds: ['request-1', 'request-2'],
            latencyTraces: [
                { id: 'trace-1', receivedAt: 10 },
                { id: 'trace-2', receivedAt: 20 },
            ],
        }));
    });

    it('should put an isolated automation prompt before pending user messages', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        queue.push('pending user message', 'remote');
        queue.unshiftIsolated('automation prompt', 'remote');

        expect(await queue.waitForMessagesAndGetAsString()).toEqual(expect.objectContaining({
            message: 'automation prompt',
            isolate: true,
        }));
        expect(await queue.waitForMessagesAndGetAsString()).toEqual(expect.objectContaining({
            message: 'pending user message',
            isolate: false,
        }));
    });

    it('should return only messages with same mode and keep others', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        queue.push('local1', 'local');
        queue.push('local2', 'local');
        queue.push('remote1', 'remote');
        queue.push('remote2', 'remote');
        
        // First call should return local messages
        const result1 = await queue.waitForMessagesAndGetAsString();
        expect(result1).not.toBeNull();
        expect(result1?.message).toBe('local1\nlocal2');
        expect(result1?.mode).toBe('local');
        expect(queue.size()).toBe(2); // remote messages still in queue
        
        // Second call should return remote messages
        const result2 = await queue.waitForMessagesAndGetAsString();
        expect(result2).not.toBeNull();
        expect(result2?.message).toBe('remote1\nremote2');
        expect(result2?.mode).toBe('remote');
        expect(queue.size()).toBe(0);
    });

    it('should handle complex mode objects', async () => {
        interface Mode {
            type: string;
            context?: string;
        }
        
        const queue = new MessageQueue2<Mode>(
            mode => `${mode.type}-${mode.context || 'default'}`
        );
        
        queue.push('message1', { type: 'local' });
        queue.push('message2', { type: 'local' });
        queue.push('message3', { type: 'local', context: 'test' });
        
        // First batch - same mode hash
        const result1 = await queue.waitForMessagesAndGetAsString();
        expect(result1).not.toBeNull();
        expect(result1?.message).toBe('message1\nmessage2');
        expect(result1?.mode).toEqual({ type: 'local' });
        
        // Second batch - different context
        const result2 = await queue.waitForMessagesAndGetAsString();
        expect(result2).not.toBeNull();
        expect(result2?.message).toBe('message3');
        expect(result2?.mode).toEqual({ type: 'local', context: 'test' });
    });

    it('should wait for messages when queue is empty', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        // Start waiting
        const waitPromise = queue.waitForMessagesAndGetAsString();
        
        // Push messages while waiting
        setTimeout(() => {
            queue.push('delayed1', 'local');
            queue.push('delayed2', 'local');
        }, 10);
        
        const result = await waitPromise;
        expect(result).not.toBeNull();
        expect(result?.message).toBe('delayed1\ndelayed2');
        expect(result?.mode).toBe('local');
    });

    it('should return null when waiting and queue closes', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        // Start waiting
        const waitPromise = queue.waitForMessagesAndGetAsString();
        
        // Close queue
        setTimeout(() => {
            queue.close();
        }, 10);
        
        const result = await waitPromise;
        expect(result).toBeNull();
    });

    it('should handle abort signal', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        const abortController = new AbortController();
        
        // Start waiting
        const waitPromise = queue.waitForMessagesAndGetAsString(abortController.signal);
        
        // Abort
        setTimeout(() => {
            abortController.abort();
        }, 10);
        
        const result = await waitPromise;
        expect(result).toBeNull();
    });

    it('should return null immediately if abort signal is already aborted', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        const abortController = new AbortController();
        
        // Abort before calling
        abortController.abort();
        
        const result = await queue.waitForMessagesAndGetAsString(abortController.signal);
        expect(result).toBeNull();
    });

    it('should handle abort signal with existing messages', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        const abortController = new AbortController();
        
        // Add messages
        queue.push('message1', 'local');
        
        // Should return messages even with abort signal
        const result = await queue.waitForMessagesAndGetAsString(abortController.signal);
        expect(result).not.toBeNull();
        expect(result?.message).toBe('message1');
    });

    it('should throw when pushing to closed queue', () => {
        const queue = new MessageQueue2<string>(mode => mode);
        queue.close();
        
        expect(() => queue.push('message', 'local')).toThrow('Cannot push to closed queue');
    });

    it('should handle multiple waiting and pushing cycles', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        // First cycle
        queue.push('cycle1', 'mode1');
        const result1 = await queue.waitForMessagesAndGetAsString();
        expect(result1?.message).toBe('cycle1');
        expect(result1?.mode).toBe('mode1');
        
        // Second cycle with waiting
        const waitPromise = queue.waitForMessagesAndGetAsString();
        queue.push('cycle2', 'mode2');
        const result2 = await waitPromise;
        expect(result2?.message).toBe('cycle2');
        expect(result2?.mode).toBe('mode2');
        
        // Third cycle
        queue.push('cycle3-1', 'mode3');
        queue.push('cycle3-2', 'mode3');
        const result3 = await queue.waitForMessagesAndGetAsString();
        expect(result3?.message).toBe('cycle3-1\ncycle3-2');
        expect(result3?.mode).toBe('mode3');
    });

    it('should batch messages with enhanced mode hashing', async () => {
        
        interface EnhancedMode {
            permissionMode: string;
            model?: string;
            fallbackModel?: string;
            customSystemPrompt?: string;
            appendSystemPrompt?: string;
            allowedTools?: string[];
            disallowedTools?: string[];
        }
        
        const queue = new MessageQueue2<EnhancedMode>(mode => hashObject(mode));
        
        // Push messages with different enhanced mode combinations
        queue.push('message1', { permissionMode: 'default', model: 'sonnet' });
        queue.push('message2', { permissionMode: 'default', model: 'sonnet' }); // Same as message1
        queue.push('message3', { permissionMode: 'default', model: 'haiku' }); // Different model
        queue.push('message4', { permissionMode: 'default', fallbackModel: 'opus' }); // Different fallback model
        queue.push('message5', { permissionMode: 'default', customSystemPrompt: 'You are a helpful assistant' }); // Different system prompt
        queue.push('message6', { permissionMode: 'default', appendSystemPrompt: 'Be concise' }); // Different append prompt
        queue.push('message7', { permissionMode: 'default', allowedTools: ['Read', 'Write'] }); // Different allowed tools
        queue.push('message8', { permissionMode: 'default', disallowedTools: ['Bash'] }); // Different disallowed tools
        
        // First batch - same permission mode and model
        const result1 = await queue.waitForMessagesAndGetAsString();
        expect(result1).not.toBeNull();
        expect(result1?.message).toBe('message1\nmessage2');
        expect(result1?.mode).toEqual({ permissionMode: 'default', model: 'sonnet' });
        expect(queue.size()).toBe(6); // remaining messages in queue
        
        // Second batch - same permission mode, different model
        const result2 = await queue.waitForMessagesAndGetAsString();
        expect(result2).not.toBeNull();
        expect(result2?.message).toBe('message3');
        expect(result2?.mode).toEqual({ permissionMode: 'default', model: 'haiku' });
        expect(queue.size()).toBe(5); // remaining messages
        
        // Third batch - same permission mode, fallback model
        const result3 = await queue.waitForMessagesAndGetAsString();
        expect(result3).not.toBeNull();
        expect(result3?.message).toBe('message4');
        expect(result3?.mode).toEqual({ permissionMode: 'default', fallbackModel: 'opus' });
        expect(queue.size()).toBe(4); // remaining messages
        
        // Fourth batch - same permission mode, custom system prompt
        const result4 = await queue.waitForMessagesAndGetAsString();
        expect(result4).not.toBeNull();
        expect(result4?.message).toBe('message5');
        expect(result4?.mode).toEqual({ permissionMode: 'default', customSystemPrompt: 'You are a helpful assistant' });
        expect(queue.size()).toBe(3); // remaining messages
        
        // Fifth batch - same permission mode, append system prompt
        const result5 = await queue.waitForMessagesAndGetAsString();
        expect(result5).not.toBeNull();
        expect(result5?.message).toBe('message6');
        expect(result5?.mode).toEqual({ permissionMode: 'default', appendSystemPrompt: 'Be concise' });
        expect(queue.size()).toBe(2); // remaining messages
        
        // Sixth batch - same permission mode, allowed tools
        const result6 = await queue.waitForMessagesAndGetAsString();
        expect(result6).not.toBeNull();
        expect(result6?.message).toBe('message7');
        expect(result6?.mode).toEqual({ permissionMode: 'default', allowedTools: ['Read', 'Write'] });
        expect(queue.size()).toBe(1); // one message left
        
        // Seventh batch - same permission mode, disallowed tools
        const result7 = await queue.waitForMessagesAndGetAsString();
        expect(result7).not.toBeNull();
        expect(result7?.message).toBe('message8');
        expect(result7?.mode).toEqual({ permissionMode: 'default', disallowedTools: ['Bash'] });
        expect(queue.size()).toBe(0);
    });

    it('should handle null reset values properly', async () => {
        
        interface EnhancedMode {
            permissionMode: string;
            model?: string;
            customSystemPrompt?: string;
            allowedTools?: string[];
            disallowedTools?: string[];
        }
        
        const queue = new MessageQueue2<EnhancedMode>(mode => hashObject(mode));
        
        // Push messages with null reset behavior
        queue.push('message1', { permissionMode: 'default', model: 'sonnet' });
        queue.push('message2', { permissionMode: 'default', model: undefined }); // Reset
        queue.push('message3', { permissionMode: 'default', customSystemPrompt: 'You are helpful' });
        queue.push('message4', { permissionMode: 'default', customSystemPrompt: undefined }); // Reset
        queue.push('message5', { permissionMode: 'default', allowedTools: ['Read', 'Write'] });
        queue.push('message6', { permissionMode: 'default', allowedTools: undefined }); // Reset
        queue.push('message7', { permissionMode: 'default', disallowedTools: ['Bash'] });
        queue.push('message8', { permissionMode: 'default', disallowedTools: undefined }); // Reset
        
        // First batch - model set
        const result1 = await queue.waitForMessagesAndGetAsString();
        expect(result1).not.toBeNull();
        expect(result1?.message).toBe('message1');
        expect(result1?.mode).toEqual({ permissionMode: 'default', model: 'sonnet' });
        
        // Second batch - model reset (undefined)
        const result2 = await queue.waitForMessagesAndGetAsString();
        expect(result2).not.toBeNull();
        expect(result2?.message).toBe('message2');
        expect(result2?.mode).toEqual({ permissionMode: 'default' }); // No model field
        
        // Third batch - custom system prompt set
        const result3 = await queue.waitForMessagesAndGetAsString();
        expect(result3).not.toBeNull();
        expect(result3?.message).toBe('message3');
        expect(result3?.mode).toEqual({ permissionMode: 'default', customSystemPrompt: 'You are helpful' });
        
        // Fourth batch - custom system prompt reset (undefined)
        const result4 = await queue.waitForMessagesAndGetAsString();
        expect(result4).not.toBeNull();
        expect(result4?.message).toBe('message4');
        expect(result4?.mode).toEqual({ permissionMode: 'default' }); // No customSystemPrompt field
        
        // Fifth batch - allowed tools set
        const result5 = await queue.waitForMessagesAndGetAsString();
        expect(result5).not.toBeNull();
        expect(result5?.message).toBe('message5');
        expect(result5?.mode).toEqual({ permissionMode: 'default', allowedTools: ['Read', 'Write'] });
        
        // Sixth batch - allowed tools reset (undefined)
        const result6 = await queue.waitForMessagesAndGetAsString();
        expect(result6).not.toBeNull();
        expect(result6?.message).toBe('message6');
        expect(result6?.mode).toEqual({ permissionMode: 'default' }); // No allowedTools field
        
        // Seventh batch - disallowed tools set
        const result7 = await queue.waitForMessagesAndGetAsString();
        expect(result7).not.toBeNull();
        expect(result7?.message).toBe('message7');
        expect(result7?.mode).toEqual({ permissionMode: 'default', disallowedTools: ['Bash'] });
        
        // Eighth batch - disallowed tools reset (undefined)
        const result8 = await queue.waitForMessagesAndGetAsString();
        expect(result8).not.toBeNull();
        expect(result8?.message).toBe('message8');
        expect(result8?.mode).toEqual({ permissionMode: 'default' }); // No disallowedTools field
        
        expect(queue.size()).toBe(0);
    });

    it('should notify waiter immediately when message is pushed', async () => {
        const queue = new MessageQueue2<string>(mode => mode);
        
        let resolved = false;
        const waitPromise = queue.waitForMessagesAndGetAsString().then(result => {
            resolved = true;
            return result;
        });
        
        // Should not be resolved yet
        expect(resolved).toBe(false);
        
        // Push message
        queue.push('immediate', 'local');
        
        // Give a tiny bit of time for promise to resolve
        await new Promise(resolve => setTimeout(resolve, 0));
        
        expect(resolved).toBe(true);
        const result = await waitPromise;
        expect(result?.message).toBe('immediate');
    });

    it('should batch messages pushed with pushImmediate normally', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        
        // Add some regular messages
        queue.push('message1', { type: 'A' });
        queue.push('message2', { type: 'A' });
        
        // Add an immediate message (does not clear or isolate)
        queue.pushImmediate('immediate', { type: 'A' });
        
        // Add more messages after
        queue.push('message3', { type: 'A' });
        queue.push('message4', { type: 'A' });
        
        // All messages should be batched together since they have the same mode
        const batch1 = await queue.waitForMessagesAndGetAsString();
        expect(batch1?.message).toBe('message1\nmessage2\nimmediate\nmessage3\nmessage4');
        expect(batch1?.mode.type).toBe('A');
    });

    it('should isolate messages pushed with pushIsolateAndClear', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        
        // Add some regular messages
        queue.push('message1', { type: 'A' });
        queue.push('message2', { type: 'A' });
        
        // Add an isolated message that clears the queue
        queue.pushIsolateAndClear('isolated', { type: 'A' });
        
        // Add more messages after
        queue.push('message3', { type: 'A' });
        queue.push('message4', { type: 'A' });
        
        // First batch should only contain the isolated message
        const batch1 = await queue.waitForMessagesAndGetAsString();
        expect(batch1?.message).toBe('isolated');
        expect(batch1?.mode.type).toBe('A');
        
        // Second batch should contain the messages added after
        const batch2 = await queue.waitForMessagesAndGetAsString();
        expect(batch2?.message).toBe('message3\nmessage4');
        expect(batch2?.mode.type).toBe('A');
    });

    it('pushIsolated does not clear pending messages and prevents batching', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);

        queue.push('first prompt', { type: 'A' });
        queue.pushIsolated('isolated command', { type: 'A' });
        queue.push('next prompt', { type: 'A' });

        expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
            message: 'first prompt',
            isolate: false,
        });

        expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
            message: 'isolated command',
            isolate: true,
        });

        expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
            message: 'next prompt',
            isolate: false,
        });
    });

    it('pushIsolated notifies waiters', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        const pending = queue.waitForMessagesAndGetAsString();

        queue.pushIsolated('/goal clear', { type: 'A' });

        await expect(pending).resolves.toMatchObject({
            message: '/goal clear',
            isolate: true,
        });
    });

    it('pushIsolated keeps attachments with the isolated message', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        const attachments = [
            {
                data: new Uint8Array([1, 2, 3]),
                mimeType: 'image/png',
                name: 'screenshot.png',
            },
        ];

        queue.push('first prompt', { type: 'A' });
        queue.pushIsolated('isolated command', { type: 'A' }, attachments);
        queue.push('next prompt', { type: 'A' });

        await queue.waitForMessagesAndGetAsString();

        expect(await queue.waitForMessagesAndGetAsString()).toMatchObject({
            message: 'isolated command',
            isolate: true,
            attachments,
        });
    });

    it('should stop batching when hitting isolated message', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        
        // Add regular messages
        queue.push('message1', { type: 'A' });
        queue.push('message2', { type: 'A' });
        
        // Manually add an isolated message without clearing (simulating edge case)
        queue.queue.push({
            message: 'isolated',
            mode: { type: 'A' },
            modeHash: 'A',
            isolate: true
        });
        
        // Add more regular messages
        queue.push('message3', { type: 'A' });
        
        // First batch should contain regular messages until the isolated one
        const batch1 = await queue.waitForMessagesAndGetAsString();
        expect(batch1?.message).toBe('message1\nmessage2');
        expect(batch1?.mode.type).toBe('A');
        
        // Second batch should only contain the isolated message
        const batch2 = await queue.waitForMessagesAndGetAsString();
        expect(batch2?.message).toBe('isolated');
        expect(batch2?.mode.type).toBe('A');
        
        // Third batch should contain messages after the isolated one
        const batch3 = await queue.waitForMessagesAndGetAsString();
        expect(batch3?.message).toBe('message3');
        expect(batch3?.mode.type).toBe('A');
    });

    it('should differentiate between pushImmediate and pushIsolateAndClear behavior', async () => {
        const queue = new MessageQueue2<{ type: string }>((mode) => mode.type);
        
        // Test pushImmediate behavior - does NOT clear queue
        queue.push('before1', { type: 'A' });
        queue.push('before2', { type: 'A' });
        queue.pushImmediate('immediate', { type: 'A' });
        queue.push('after', { type: 'A' });
        
        // All should be batched together
        const batch1 = await queue.waitForMessagesAndGetAsString();
        expect(batch1?.message).toBe('before1\nbefore2\nimmediate\nafter');
        expect(batch1?.mode.type).toBe('A');
        
        // Test pushIsolateAndClear behavior - DOES clear queue and isolate
        queue.push('will-be-cleared1', { type: 'B' });
        queue.push('will-be-cleared2', { type: 'B' });
        queue.pushIsolateAndClear('isolated', { type: 'B' });
        queue.push('after-isolated', { type: 'B' });
        
        // First batch should only be the isolated message
        const batch2 = await queue.waitForMessagesAndGetAsString();
        expect(batch2?.message).toBe('isolated');
        expect(batch2?.mode.type).toBe('B');
        
        // Second batch should be the message added after
        const batch3 = await queue.waitForMessagesAndGetAsString();
        expect(batch3?.message).toBe('after-isolated');
        expect(batch3?.mode.type).toBe('B');
    });
});

describe('channel request correlation', () => {
    // Saycode specs/desktop-messenger-channels — the handle has to survive the queue, because the
    // turn that eventually runs is what the reply must be matched against.
    it('carries an isolated message’s request id through to the batch', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.pushIsolated('from telegram', 'm', undefined, undefined, 'core-req-1');
        expect(queue.queue.length).toBe(1);
        const batch = (queue as unknown as { collectBatch(): { channelRequestId?: string } }).collectBatch();
        expect(batch.channelRequestId).toBe('core-req-1');
    });

    it('does not read an auto-routing id as a channel request', () => {
        // Both kinds of id travel through this queue. Ordinary Desktop input carries routing ids,
        // and a consumer that took "has an id" to mean "came from a channel" would put that input
        // behind channel execution approval — which never arrives for it — and disable its slash
        // commands.
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('typed in the app', 'm', undefined, ['route-1']);
        const batch = (queue as unknown as { collectBatch(): { channelRequestId?: string; requestIds?: string[] } }).collectBatch();
        expect(batch.requestIds).toEqual(['route-1']);
        expect(batch.channelRequestId).toBeUndefined();
    });

    it('removes only the tagged channel request, never routed Desktop input', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('typed in the app', 'm', undefined, ['core-req-4']);
        queue.pushIsolated('from telegram', 'm', undefined, undefined, 'core-req-4');
        expect(queue.removeByRequestId('core-req-4')).toBe(1);
        expect(queue.queue.map(item => item.message)).toEqual(['typed in the app']);
    });

    it('reports no request ids for ordinary in-app messages', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('typed in the app', 'm');
        const batch = (queue as unknown as { collectBatch(): { channelRequestId?: string } }).collectBatch();
        expect(batch.channelRequestId).toBeUndefined();
    });

    it('does not let a channel turn batch with in-app messages', () => {
        // Same mode, so `push` would have merged them into one turn with two askers and no way to
        // say which reply answers which request.
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('typed in the app', 'm');
        queue.pushIsolated('from telegram', 'm', undefined, undefined, 'core-req-2');

        const first = (queue as unknown as { collectBatch(): { message: string; channelRequestId?: string } }).collectBatch();
        expect(first.message).toBe('typed in the app');
        expect(first.channelRequestId).toBeUndefined();

        const second = (queue as unknown as { collectBatch(): { message: string; channelRequestId?: string } }).collectBatch();
        expect(second.message).toBe('from telegram');
        expect(second.channelRequestId).toBe('core-req-2');
    });

    it('keeps already-queued work when a channel message arrives', () => {
        // `pushIsolateAndClear` would have discarded it; `pushIsolated` must not.
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('work someone is waiting on', 'm');
        queue.pushIsolated('from telegram', 'm', undefined, undefined, 'core-req-3');
        expect(queue.queue.length).toBe(2);
    });
});

/**
 * A batch merges N user inputs into one execution. Auto-routing commits its
 * floor and its counters at that execution, so it needs every merged input's
 * request id — `collectBatch` previously kept only the first item's mode and
 * silently dropped the rest, which would have attributed a batch to one input.
 *
 * The ids travel beside the mode, not inside it: putting them in the mode would
 * change its hash and stop the batching this is meant to describe.
 */
describe('MessageQueue2 batch request identity', async () => {
    it('shouldReturnEveryMergedRequestIdInBatchOrder', async () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'same', undefined, ['req-1']);
        queue.push('two', 'same', undefined, ['req-2']);

        const batch = (await queue.waitForMessagesAndGetAsString());

        expect(batch?.message).toBe('one\ntwo');
        expect(batch?.requestIds).toEqual(['req-1', 'req-2']);
    });

    it('shouldNotChangeTheModeHashWhenRequestIdsDiffer', async () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'same', undefined, ['req-1']);
        queue.push('two', 'same', undefined, ['req-2']);

        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toHaveLength(2);
    });

    it('shouldOmitRequestIdsWhenNoMessageCarriedOne', async () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'same');

        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toBeUndefined();
    });

    it('shouldNotLeakRequestIdsFromABatchThatWasNotCollected', async () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'modeA', undefined, ['req-1']);
        queue.push('two', 'modeB', undefined, ['req-2']);

        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-1']);
        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-2']);
    });

    it('shouldKeepOnlyTheIsolatedMessagesOwnRequestId', async () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'same', undefined, ['req-1']);
        queue.pushIsolated('alone', 'same', undefined, ['req-2']);

        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-1']);
        expect((await queue.waitForMessagesAndGetAsString())?.requestIds).toEqual(['req-2']);
    });
});

describe('MessageQueue2 discarded request identity', () => {
    it('shouldReportTheRequestIdsItFlushed', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'm', undefined, ['req-1']);
        queue.push('two', 'm', undefined, ['req-2']);

        expect(queue.pushIsolateAndClear('/clear', 'm')).toEqual(['req-1', 'req-2']);
    });

    it('shouldReportNothingWhenThereWasNothingToFlush', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        expect(queue.pushIsolateAndClear('/clear', 'm')).toEqual([]);
    });

    it('shouldNotReportTheIsolatedMessagesOwnQueueEntry', () => {
        const queue = new MessageQueue2<string>((mode) => mode);
        queue.push('one', 'm', undefined, ['req-1']);

        const discarded = queue.pushIsolateAndClear('/clear', 'm');

        expect(discarded).toEqual(['req-1']);
        expect(queue.size()).toBe(1);
    });
});
