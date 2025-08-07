import { describe, it, expect } from 'vitest';
import { MessageQueue2 } from './MessageQueue2';

describe('MessageQueue2', () => {
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
});