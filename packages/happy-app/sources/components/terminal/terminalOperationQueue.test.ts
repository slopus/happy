import { describe, expect, it, vi } from 'vitest';
import { TerminalOperationQueue } from './terminalOperationQueue';

describe('TerminalOperationQueue', () => {
    it('holds every operation until ready and drains in exact order', () => {
        const execute = vi.fn();
        const queue = new TerminalOperationQueue(execute);

        queue.enqueue({ type: 'reset' });
        queue.enqueue({ type: 'write', data: 'snapshot' });
        queue.enqueue({ type: 'write', data: 'replay' });
        queue.enqueue({ type: 'write', data: 'live' });
        queue.enqueue({ type: 'setReadOnly', readOnly: true });
        expect(execute).not.toHaveBeenCalled();

        queue.markReady();
        expect(execute.mock.calls.map(([operation]) => operation)).toEqual([
            { type: 'reset' },
            { type: 'write', data: 'snapshot' },
            { type: 'write', data: 'replay' },
            { type: 'write', data: 'live' },
            { type: 'setReadOnly', readOnly: true },
        ]);

        queue.enqueue({ type: 'focus' });
        expect(execute).toHaveBeenLastCalledWith({ type: 'focus' });
    });

    it('buffers again while a WebView reload is not ready', () => {
        const operations: string[] = [];
        const queue = new TerminalOperationQueue((operation) => operations.push(operation.type));
        queue.markReady();
        queue.enqueue({ type: 'write', data: 'before-reload' });

        queue.markNotReady();
        queue.enqueue({ type: 'reset' });
        queue.enqueue({ type: 'write', data: 'after-reload' });
        expect(operations).toEqual(['write']);

        queue.markReady();
        expect(operations).toEqual(['write', 'reset', 'write']);
    });
});
