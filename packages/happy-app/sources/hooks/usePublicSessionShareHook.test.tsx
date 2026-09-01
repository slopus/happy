import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    job: null as any,
    listeners: new Set<() => void>(),
    enqueue: vi.fn(),
    cancel: vi.fn(),
    getShare: vi.fn(async () => ({ active: false, publicId: null, publishedAt: null })),
    revoke: vi.fn(async () => undefined),
    alert: vi.fn(),
    platformOS: 'android',
    hasPendingMessages: false,
    credentials: { token: 'token', secret: 'secret' },
}));

vi.mock('@/sync/publicSessionShareQueueRuntime', () => ({
    enqueuePublicSessionShareJob: mocks.enqueue,
    cancelPublicSessionShareJob: mocks.cancel,
    getPublicSessionShareJob: () => mocks.job,
    subscribePublicSessionShareJobs: (listener: () => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
    },
}));
vi.mock('@/sync/apiPublicSessionShares', () => ({
    getPublicSessionShare: mocks.getShare,
    getPublicSessionShareUrl: (publicId: string) => `https://paws.test/share/${publicId}`,
    revokePublicSessionShare: mocks.revoke,
}));
vi.mock('@/sync/storage', () => ({ useSetting: () => true }));
vi.mock('@/sync/sync', () => ({
    sync: {
        getCredentials: () => mocks.credentials,
        getSessionLastMessageSeq: () => 42,
        hasPendingOutboxMessagesForSession: () => mocks.hasPendingMessages,
    },
}));
vi.mock('@/hooks/useHappyAction', () => ({
    useHappyAction: (action: (...args: any[]) => Promise<void>) => [false, (...args: any[]) => { void action(...args); }],
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert } }));
vi.mock('react-native', () => ({ Platform: { get OS() { return mocks.platformOS; } } }));
vi.mock('@/encryption/blob', () => ({ decryptBlob: vi.fn() }));
vi.mock('@/sync/apiAttachments', () => ({
    downloadEncryptedAttachment: vi.fn(),
    requestAttachmentDownloadSource: vi.fn(),
}));
vi.mock('@/sync/publicSessionSharePublishing', () => ({
    loadCompleteSessionMessages: vi.fn(async () => []),
    publishPublicSessionSnapshot: vi.fn(async () => ({ publicId: 'legacy-public-id', publishedAt: 1 })),
}));

import { usePublicSessionShare } from './usePublicSessionShare';

describe('usePublicSessionShare', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.job = null;
        mocks.platformOS = 'android';
        mocks.hasPendingMessages = false;
        mocks.listeners.clear();
        mocks.enqueue.mockImplementation((input) => {
            mocks.job = {
                id: 'job-1', ...input, status: 'queued', progress: { completed: 0, total: 0 }, updatedAt: input.requestedAt,
            };
            for (const listener of mocks.listeners) listener();
            return mocks.job;
        });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    it('queues publication immediately and follows the persisted job to its ready link', async () => {
        let latest: ReturnType<typeof usePublicSessionShare> | null = null;
        function Harness() {
            latest = usePublicSessionShare('session-1', 'Release notes');
            return null;
        }
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(<Harness />);
        });
        const current = () => latest as ReturnType<typeof usePublicSessionShare>;
        await vi.waitFor(() => expect(current().checking).toBe(false));

        let accepted = false;
        act(() => { accepted = latest!.publish(); });

        expect(accepted).toBe(true);
        expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1', title: 'Release notes', groupToolCalls: true, requestedAt: expect.any(Number),
        }));
        expect(current().publishing).toBe(true);

        act(() => {
            mocks.job = {
                ...mocks.job, status: 'ready', publicId: 'public-id', publishedAt: 300,
                progress: { completed: 2, total: 2 }, updatedAt: 300,
            };
            for (const listener of mocks.listeners) listener();
        });

        expect(current().shareState).toEqual({ active: true, publicId: 'public-id', publishedAt: 300 });
        expect(current().shareUrl).toBe('https://paws.test/share/public-id');
        expect(current().publishing).toBe(false);
        act(() => renderer.unmount());
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('reports a queued publication failure inside the Web dialog', async () => {
        mocks.platformOS = 'web';
        let latest: ReturnType<typeof usePublicSessionShare> | null = null;
        function Harness() {
            latest = usePublicSessionShare('session-1', 'Release notes');
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Harness />); });
        const current = () => latest as ReturnType<typeof usePublicSessionShare>;
        await vi.waitFor(() => expect(current().checking).toBe(false));

        act(() => { current().publish(); });
        act(() => {
            mocks.job = {
                ...mocks.job,
                status: 'failed',
                error: 'network unavailable',
                notificationPending: true,
                updatedAt: 400,
            };
            for (const listener of mocks.listeners) listener();
        });

        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'network unavailable');
        act(() => {
            mocks.job = { ...mocks.job, notificationPending: false, updatedAt: 401 };
            for (const listener of mocks.listeners) listener();
        });
        expect(mocks.alert).toHaveBeenCalledOnce();
        act(() => renderer.unmount());
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('keeps sharing disabled while a visible message still lacks a server sequence', async () => {
        mocks.hasPendingMessages = true;
        let latest: ReturnType<typeof usePublicSessionShare> | null = null;
        function Harness() {
            latest = usePublicSessionShare('session-1', 'Release notes');
            return null;
        }
        let renderer: any;
        await act(async () => { renderer = TestRenderer.create(<Harness />); });
        const current = () => latest as ReturnType<typeof usePublicSessionShare>;
        await vi.waitFor(() => expect(current().checking).toBe(false));

        let accepted = true;
        act(() => { accepted = current().publish(); });

        expect(accepted).toBe(false);
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.alert).toHaveBeenCalledWith('common.error', 'sessionShare.pendingMessages');
        act(() => renderer.unmount());
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });
});
