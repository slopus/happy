import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutgoingMessageQueue } from './OutgoingMessageQueue';

describe('OutgoingMessageQueue', () => {
    let sentMessages: any[];
    let queue: OutgoingMessageQueue;

    beforeEach(() => {
        sentMessages = [];
        queue = new OutgoingMessageQueue((msg) => sentMessages.push(msg));
    });

    afterEach(() => {
        queue.destroy();
    });

    // Small delay to let the async lock chain and setTimeout(0) scheduling resolve
    const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

    it('should send non-delayed messages immediately', async () => {
        queue.enqueue({ type: 'text', content: 'hello' });
        await tick();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('hello');
    });

    it('should send multiple non-delayed messages in order', async () => {
        queue.enqueue({ type: 'text', content: 'first' });
        queue.enqueue({ type: 'text', content: 'second' });
        queue.enqueue({ type: 'text', content: 'third' });
        await tick();

        expect(sentMessages).toHaveLength(3);
        expect(sentMessages[0].content).toBe('first');
        expect(sentMessages[1].content).toBe('second');
        expect(sentMessages[2].content).toBe('third');
    });

    it('should delay messages with delay option', async () => {
        queue.enqueue({ type: 'text', content: 'delayed' }, { delay: 100 });
        await tick();
        expect(sentMessages).toHaveLength(0);

        // Wait for delay to expire
        await tick(150);

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('delayed');
    });

    it('should NOT block released messages behind unreleased ones', async () => {
        // This is the core fix for head-of-line blocking (#639)
        queue.enqueue({ type: 'text', content: 'delayed-tool-call' }, {
            delay: 200,
            toolCallIds: ['tool-1']
        });
        queue.enqueue({ type: 'text', content: 'immediate-result' });
        await tick();

        // The immediate message should be sent even though delayed one is in queue
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('immediate-result');

        // After delay expires, the delayed message should also be sent
        await tick(250);

        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1].content).toBe('delayed-tool-call');
    });

    it('should release delayed messages via releaseToolCall', async () => {
        queue.enqueue({ type: 'text', content: 'tool-call-msg' }, {
            delay: 500,
            toolCallIds: ['tool-1']
        });
        await tick();
        expect(sentMessages).toHaveLength(0);

        // Release via tool call ID (before delay expires)
        await queue.releaseToolCall('tool-1');
        await tick();

        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('tool-call-msg');
    });

    it('should not send system type messages', async () => {
        queue.enqueue({ type: 'system', content: 'internal' });
        await tick();

        expect(sentMessages).toHaveLength(0);
    });

    it('should flush all messages immediately', async () => {
        queue.enqueue({ type: 'text', content: 'delayed1' }, { delay: 500 });
        queue.enqueue({ type: 'text', content: 'delayed2' }, { delay: 500 });
        queue.enqueue({ type: 'text', content: 'immediate' });
        await tick();

        // Only immediate should have been sent (delayed ones skipped)
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('immediate');

        await queue.flush();
        await tick();

        expect(sentMessages).toHaveLength(3);
    });

    it('should handle interleaved delayed and immediate messages', async () => {
        queue.enqueue({ type: 'text', content: 'tool-call-1' }, { delay: 200, toolCallIds: ['t1'] });
        queue.enqueue({ type: 'text', content: 'sidechain-result' });
        queue.enqueue({ type: 'text', content: 'tool-call-2' }, { delay: 200, toolCallIds: ['t2'] });
        await tick();

        // The sidechain result should be sent immediately
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0].content).toBe('sidechain-result');

        // After 200ms both tool calls should be released
        await tick(250);

        expect(sentMessages).toHaveLength(3);
    });
});
