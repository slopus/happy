import { describe, expect, it, vi } from 'vitest';

import { enqueueCodexUserText, shouldHandleCodexClear } from './codexClearCommand';

describe('enqueueCodexUserText', () => {
    it('preserves the opt-in trace beside routing ids and attachments', () => {
        const queue = { push: vi.fn(), pushIsolateAndClear: vi.fn() };
        const latencyTrace = { id: 'trace', receivedAt: 10 };
        const input = { text: 'OK', mode: 'mode', queue, requestIds: ['route'], latencyTrace };
        enqueueCodexUserText(input);
        expect(queue.push).toHaveBeenCalledWith('OK', 'mode', undefined, ['route'], latencyTrace);
    });

    it('preserves the trace when an isolated clear command is queued', () => {
        const queue = { push: vi.fn(), pushIsolateAndClear: vi.fn() };
        const latencyTrace = { id: 'trace', receivedAt: 10 };
        enqueueCodexUserText({ text: '/clear', mode: 'mode', queue, ...{ latencyTrace } });
        expect(queue.pushIsolateAndClear).toHaveBeenCalledWith('/clear', 'mode', undefined, latencyTrace);
    });

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
        // Fourth argument is the routing request ids, absent for this call.
        expect(queue.push).toHaveBeenCalledWith('inspect this image', mode, attachments, undefined);
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


describe('enqueueCodexUserText routing request ids', () => {
    it('shouldForwardRequestIdsForAQueuedTurn', () => {
        const queue = { push: vi.fn(), pushIsolateAndClear: vi.fn() };

        enqueueCodexUserText({
            text: 'refactor this',
            mode: 'mode',
            queue,
            requestIds: ['req-1'],
        });

        expect(queue.push).toHaveBeenCalledWith('refactor this', 'mode', undefined, ['req-1']);
    });
});

/**
 * The consumer-side gate (Saycode specs/desktop-messenger-channels — R1/R5).
 *
 * A channel turn never passes the enqueue-side parser, so this is the only place left that can
 * refuse to read relayed text as session control. `/clear` here wipes the Codex thread state —
 * an external sender must not be able to reach it, and the daemon advertises `codex`, so this
 * engine is reachable from a channel today.
 */
describe('shouldHandleCodexClear', () => {
    it('handles a local /clear', () => {
        expect(shouldHandleCodexClear({ message: '/clear' })).toBe(true);
    });

    it('refuses a channel /clear — the reset an external sender must not reach', () => {
        expect(shouldHandleCodexClear({ message: '/clear', channelRequestId: 'req-1' })).toBe(false);
    });

    it('leaves ordinary channel text alone either way', () => {
        expect(shouldHandleCodexClear({ message: 'what changed today?', channelRequestId: 'req-1' })).toBe(false);
        expect(shouldHandleCodexClear({ message: 'what changed today?' })).toBe(false);
    });

    it('still handles a local /clear that carries auto-routing ids', () => {
        // Routing ids ride on ordinary Desktop input. Reading them as channel origin would take
        // `/clear` away from the person sitting at the app.
        const message: { message: string; requestIds?: string[]; channelRequestId?: string } = {
            message: '/clear', requestIds: ['route-1'],
        };
        expect(shouldHandleCodexClear(message)).toBe(true);
    });
});
