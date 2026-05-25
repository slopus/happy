import { describe, expect, it, vi } from 'vitest';

import { enqueueCodexUserText } from './codexClearCommand';

describe('enqueueCodexUserText', () => {
    it('queues /clear in isolation instead of batching it into a model prompt', () => {
        const mode = { permissionMode: 'default' as const };
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '  /clear  ',
            mode,
            queue,
        });

        expect(result).toBe('clear');
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('  /clear  ', mode);
        expect(queue.push).not.toHaveBeenCalled();
    });
});
