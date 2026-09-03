import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicSessionShareJob } from './publicSessionShareQueue';

const mocks = vi.hoisted(() => ({
    schedule: vi.fn(async () => 'notification-id'),
    platformOS: 'android',
}));

vi.mock('expo-notifications', () => ({ scheduleNotificationAsync: mocks.schedule }));
vi.mock('react-native', () => ({
    Platform: { get OS() { return mocks.platformOS; } },
}));
vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => params?.title ? `${key}:${params.title}` : key,
}));

import { notifyPublicSessionShareJob } from './publicSessionShareNotifications';

const base: PublicSessionShareJob = {
    id: 'job-1', sessionId: 'session-1', title: 'Release notes', requestedAt: 100,
    cutoffSeq: 42, ownerId: 'owner-1', serverUrl: 'https://paws.test',
    groupToolCalls: true, themePack: 'caramel', status: 'ready', progress: { completed: 1, total: 1 },
    notificationPending: false, updatedAt: 200,
    publicId: 'public-id', publishedAt: 200,
};

describe('notifyPublicSessionShareJob', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.platformOS = 'android';
    });

    it('posts a tappable completion notification for a ready link', async () => {
        await notifyPublicSessionShareJob(base);

        expect(mocks.schedule).toHaveBeenCalledWith({
            content: {
                title: 'sessionShare.readyNotificationTitle',
                body: 'sessionShare.readyNotificationBody:Release notes',
                data: {
                    kind: 'share-ready',
                    sessionId: 'session-1',
                    url: '/session/session-1',
                    publicId: 'public-id',
                },
                sound: true,
                badge: 1,
            },
            trigger: { channelId: 'messages' },
        });
    });

    it('posts a retry notification after a failed publication', async () => {
        await notifyPublicSessionShareJob({ ...base, status: 'failed', publicId: undefined, publishedAt: undefined, error: 'offline' });

        expect(mocks.schedule).toHaveBeenCalledWith(expect.objectContaining({
            content: expect.objectContaining({
                title: 'sessionShare.failedNotificationTitle',
                body: 'sessionShare.failedNotificationBody:Release notes',
                data: expect.objectContaining({ kind: 'share-failed', sessionId: 'session-1' }),
            }),
        }));
    });

    it('does not request a native notification on web', async () => {
        mocks.platformOS = 'web';
        await notifyPublicSessionShareJob(base);
        expect(mocks.schedule).not.toHaveBeenCalled();
    });
});
