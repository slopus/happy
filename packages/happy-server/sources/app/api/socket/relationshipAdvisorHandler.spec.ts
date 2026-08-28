import { describe, expect, it, vi } from 'vitest';

import { relationshipAdvisorHandler } from '@/app/api/socket/relationshipAdvisorHandler';

type Listener = (...args: any[]) => void;

class FakeSocket {
    private listeners = new Map<string, Listener>();
    readonly emitted: Array<{ event: string; data: unknown }> = [];

    on(event: string, listener: Listener) {
        this.listeners.set(event, listener);
        return this;
    }

    emit(event: string, data: unknown) {
        this.emitted.push({ event, data });
        return true;
    }

    receive(event: string, ...args: unknown[]) {
        const listener = this.listeners.get(event);
        if (!listener) throw new Error(`No listener registered for ${event}`);
        listener(...args);
    }
}

describe('relationshipAdvisorHandler', () => {
    it('acknowledges immediately and streams text deltas to the requesting socket', async () => {
        const socket = new FakeSocket();
        const streamChat = vi.fn(async function* () {
            yield { text: '先别急，' };
            yield { text: '我们看事实。' };
        });
        const acknowledge = vi.fn();

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat,
            requireImageReadPermission: vi.fn(async () => undefined),
            requireImageWritePermission: vi.fn(async () => undefined),
            resolveImageUrls: vi.fn(async () => []),
        });

        socket.receive('relationship-advisor:start', {
            requestId: 'request-1',
            messages: [{ role: 'user', text: '她只回了哈哈，我怎么接？' }],
            imageRefs: [],
        }, acknowledge);

        await vi.waitFor(() => {
            expect(socket.emitted.at(-1)).toEqual({
                event: 'relationship-advisor:event',
                data: { requestId: 'request-1', type: 'done' },
            });
        });

        expect(acknowledge).toHaveBeenCalledWith({ ok: true });
        expect(socket.emitted).toEqual([
            {
                event: 'relationship-advisor:event',
                data: { requestId: 'request-1', type: 'accepted' },
            },
            {
                event: 'relationship-advisor:event',
                data: { requestId: 'request-1', type: 'delta', text: '先别急，' },
            },
            {
                event: 'relationship-advisor:event',
                data: { requestId: 'request-1', type: 'delta', text: '我们看事实。' },
            },
            {
                event: 'relationship-advisor:event',
                data: { requestId: 'request-1', type: 'done' },
            },
        ]);
        expect(streamChat).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-1',
            messages: [{ role: 'user', text: '她只回了哈哈，我怎么接？' }],
            imageUrls: [],
        }));
    });

    it('aborts the matching provider stream when the client cancels', async () => {
        const socket = new FakeSocket();
        const streamChat = vi.fn(async function* (input: { signal?: AbortSignal }) {
            yield { text: '先看一下' };
            await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
        });

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat: streamChat as any,
            requireImageReadPermission: vi.fn(async () => undefined),
            requireImageWritePermission: vi.fn(async () => undefined),
            resolveImageUrls: vi.fn(async () => []),
        });

        socket.receive('relationship-advisor:start', {
            requestId: 'request-2',
            messages: [{ role: 'user', text: '帮我分析' }],
            imageRefs: [],
        }, vi.fn());

        await vi.waitFor(() => {
            expect(socket.emitted).toContainEqual({
                event: 'relationship-advisor:event',
                data: { requestId: 'request-2', type: 'delta', text: '先看一下' },
            });
        });

        socket.receive('relationship-advisor:cancel', { requestId: 'request-2' });

        await vi.waitFor(() => {
            expect(socket.emitted.at(-1)).toEqual({
                event: 'relationship-advisor:event',
                data: { requestId: 'request-2', type: 'done' },
            });
        });
        const signal = streamChat.mock.calls.at(0)?.[0].signal;
        expect(signal).toBeDefined();
        expect(signal?.aborted).toBe(true);
    });

    it('rejects malformed requests before calling the provider', () => {
        const socket = new FakeSocket();
        const streamChat = vi.fn();
        const acknowledge = vi.fn();

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat: streamChat as any,
            requireImageReadPermission: vi.fn(async () => undefined),
            requireImageWritePermission: vi.fn(async () => undefined),
            resolveImageUrls: vi.fn(async () => []),
        });

        socket.receive('relationship-advisor:start', {
            requestId: '',
            messages: [],
            imageRefs: ['not-an-advisor-ref'],
        }, acknowledge);

        expect(acknowledge).toHaveBeenCalledWith({ ok: false, error: 'Invalid request' });
        expect(streamChat).not.toHaveBeenCalled();
        expect(socket.emitted).toEqual([]);
    });

    it('returns a safe error event when the provider stream fails', async () => {
        const socket = new FakeSocket();

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat: async function* () {
                throw new Error('upstream secret response');
            },
            requireImageReadPermission: vi.fn(async () => undefined),
            requireImageWritePermission: vi.fn(async () => undefined),
            resolveImageUrls: vi.fn(async () => []),
        });

        socket.receive('relationship-advisor:start', {
            requestId: 'request-3',
            messages: [{ role: 'user', text: '帮我看看' }],
            imageRefs: [],
        }, vi.fn());

        await vi.waitFor(() => {
            expect(socket.emitted.at(-1)).toEqual({
                event: 'relationship-advisor:event',
                data: {
                    requestId: 'request-3',
                    type: 'error',
                    error: 'Relationship advisor is temporarily unavailable',
                },
            });
        });
        expect(JSON.stringify(socket.emitted)).not.toContain('upstream secret response');
    });

    it('allows only one active generation per socket', async () => {
        const socket = new FakeSocket();
        const streamChat = vi.fn(async function* (input: { signal?: AbortSignal }) {
            await new Promise<void>((resolve) => input.signal?.addEventListener('abort', () => resolve(), { once: true }));
        });
        const secondAcknowledge = vi.fn();

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat: streamChat as any,
            requireImageReadPermission: vi.fn(async () => undefined),
            requireImageWritePermission: vi.fn(async () => undefined),
            resolveImageUrls: vi.fn(async () => []),
        });
        socket.receive('relationship-advisor:start', {
            requestId: 'request-4',
            messages: [{ role: 'user', text: '第一条' }],
            imageRefs: [],
        }, vi.fn());
        socket.receive('relationship-advisor:start', {
            requestId: 'request-5',
            messages: [{ role: 'user', text: '第二条' }],
            imageRefs: [],
        }, secondAcknowledge);

        expect(secondAcknowledge).toHaveBeenCalledWith({ ok: false, error: 'Request already active' });
        await vi.waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
        socket.receive('relationship-advisor:cancel', { requestId: 'request-4' });
    });

    it('checks image-read permission before resolving plugin image references', async () => {
        const socket = new FakeSocket();
        const requireImageReadPermission = vi.fn(async () => {
            throw new Error('plugin not installed');
        });
        const resolveImageUrls = vi.fn(async () => ['https://storage.example/image']);
        const streamChat = vi.fn();
        const requireImageWritePermission = vi.fn(async () => undefined);
        const deleteImageRefs = vi.fn(async () => undefined);

        relationshipAdvisorHandler('user-1', socket as any, {
            streamChat: streamChat as any,
            requireImageReadPermission,
            requireImageWritePermission,
            resolveImageUrls,
            deleteImageRefs,
        });
        socket.receive('relationship-advisor:start', {
            requestId: 'request-image-denied',
            messages: [{ role: 'user', text: '看图' }],
            imageRefs: ['advisor/user-1/12345678-1234-1234-1234-123456789abc.jpg'],
        }, vi.fn());

        await vi.waitFor(() => {
            expect(socket.emitted.at(-1)).toEqual({
                event: 'relationship-advisor:event',
                data: {
                    requestId: 'request-image-denied',
                    type: 'error',
                    error: 'Relationship advisor is temporarily unavailable',
                },
            });
        });
        expect(requireImageReadPermission).toHaveBeenCalledWith('user-1');
        expect(requireImageWritePermission).not.toHaveBeenCalled();
        expect(resolveImageUrls).not.toHaveBeenCalled();
        expect(streamChat).not.toHaveBeenCalled();
        expect(deleteImageRefs).not.toHaveBeenCalled();
    });
});
