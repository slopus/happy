import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    jobs: [] as any[],
    publish: vi.fn(),
    notify: vi.fn(async () => undefined),
}));

vi.mock('./publicSessionShareQueuePersistence', () => ({
    publicSessionShareQueueStorage: {
        load: () => mocks.jobs,
        save: (jobs: any[]) => { mocks.jobs = jobs; },
    },
}));
vi.mock('./publicSessionSharePublishing', () => ({
    loadSessionMessagesThroughSequence: vi.fn(),
    publishPublicSessionSnapshot: mocks.publish,
}));
vi.mock('./publicSessionShareNotifications', () => ({ notifyPublicSessionShareJob: mocks.notify }));
vi.mock('./storage', () => ({
    storage: { getState: () => ({ sessionMessages: {} }) },
}));
vi.mock('./sync', () => ({
    sync: {
        getCredentials: () => ({ token: 'token', secret: 'secret' }),
        serverID: 'owner-1',
        encryption: { getSessionBlobKey: vi.fn(), getSessionEncryption: vi.fn() },
    },
}));
vi.mock('./serverConfig', () => ({ getServerUrl: () => 'https://paws.test' }));
vi.mock('./apiSocket', () => ({ apiSocket: { request: vi.fn() } }));
vi.mock('./typesRaw', () => ({ normalizeRawMessage: vi.fn() }));
vi.mock('./apiAttachments', () => ({
    downloadEncryptedAttachment: vi.fn(),
    requestAttachmentDownloadSource: vi.fn(),
}));
vi.mock('./apiPublicSessionShares', () => ({
    clonePublicSessionCover: vi.fn(),
    createPublicSessionShareDraft: vi.fn(),
    preparePublicSessionShareAsset: vi.fn(),
    publishPublicSessionShareDraft: vi.fn(),
    revokePublicSessionShare: vi.fn(),
    uploadPublicSessionShareAsset: vi.fn(),
}));
vi.mock('@/encryption/blob', () => ({ decryptBlob: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import {
    enqueuePublicSessionShareJob,
    getPublicSessionShareJob,
    resumePublicSessionShareJobs,
} from './publicSessionShareQueueRuntime';

describe('public session share queue runtime', () => {
    it('runs a persisted publication outside the dialog and exposes its ready result', async () => {
        mocks.publish.mockResolvedValueOnce({ publicId: 'public-id', publishedAt: 300 });

        const queued = enqueuePublicSessionShareJob({
            sessionId: 'session-1', title: 'Release notes', requestedAt: 200, cutoffSeq: 42, groupToolCalls: true,
        });
        expect(queued.status).toBe('queued');

        await resumePublicSessionShareJobs();

        expect(mocks.publish).toHaveBeenCalledWith(
            {
                sessionId: 'session-1',
                jobId: queued.id,
                title: 'Release notes',
                sharedAt: 200,
                themePack: 'caramel',
                coverSelection: undefined,
                groupToolCalls: true,
            },
            expect.objectContaining({
                cloneExistingCover: expect.any(Function),
                isCancelled: expect.any(Function),
                onProgress: expect.any(Function),
            }),
        );
        expect(getPublicSessionShareJob('session-1')).toMatchObject({
            status: 'ready', publicId: 'public-id', publishedAt: 300,
            cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test', notificationPending: false,
        });
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', publicId: 'public-id' }));
    });
});
