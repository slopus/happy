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
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('  /clear  ', mode, undefined);
        expect(queue.push).not.toHaveBeenCalled();
    });

    it('passes attachments to normal queued messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([1, 2, 3]),
            mimeType: 'image/png',
            name: 'screen.png',
        }];
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: 'inspect this image',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('queued');
        expect(queue.push).toHaveBeenCalledWith('inspect this image', mode, attachments);
        expect(queue.pushIsolateAndClear).not.toHaveBeenCalled();
    });

    it('passes attachments to isolated clear messages', () => {
        const mode = { permissionMode: 'default' as const };
        const attachments = [{
            data: new Uint8Array([4, 5, 6]),
            mimeType: 'image/jpeg',
            name: 'photo.jpg',
        }];
        const queue = {
            push: vi.fn(),
            pushIsolateAndClear: vi.fn(),
        };

        const result = enqueueCodexUserText({
            text: '/clear',
            mode,
            queue,
            attachments,
        });

        expect(result).toBe('clear');
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', mode, attachments);
        expect(queue.push).not.toHaveBeenCalled();
    });
});
