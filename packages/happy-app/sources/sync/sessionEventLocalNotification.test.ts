import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationsMock = vi.hoisted(() => ({
    scheduleNotificationAsync: vi.fn(),
}));

const reactNativeMock = vi.hoisted(() => ({
    Platform: { OS: 'android' },
}));

const logMock = vi.hoisted(() => ({
    log: vi.fn(),
}));

vi.mock('expo-notifications', () => notificationsMock);
vi.mock('react-native', () => reactNativeMock);
vi.mock('@/log', () => ({ log: logMock }));

import {
    getInitialSessionEventLocalNotificationsEnabled,
    maybeScheduleSessionEventLocalNotification,
    shouldEnableSessionEventLocalNotifications,
} from './sessionEventLocalNotification';

const sessionEvent = {
    type: 'session-event' as const,
    sessionId: 'session-123',
    kind: 'permission' as const,
    title: 'Codex needs approval',
    body: 'Review the requested command.',
    timestamp: 123456,
};

describe('sessionEventLocalNotification', () => {
    beforeEach(() => {
        reactNativeMock.Platform.OS = 'android';
        vi.clearAllMocks();
        notificationsMock.scheduleNotificationAsync.mockResolvedValue('notification-id');
    });

    it('schedules an immediate local notification for a session event when fallback is enabled', async () => {
        const scheduled = await maybeScheduleSessionEventLocalNotification(sessionEvent, { enabled: true });

        expect(scheduled).toBe(true);
        expect(notificationsMock.scheduleNotificationAsync).toHaveBeenCalledWith({
            content: {
                title: 'Codex needs approval',
                body: 'Review the requested command.',
                data: {
                    kind: 'permission',
                    sessionId: 'session-123',
                    timestamp: 123456,
                    url: '/session/session-123',
                    source: 'session-event-local-fallback',
                },
                sound: true,
                badge: 1,
            },
            trigger: {
                channelId: 'messages',
            },
        });
    });

    it('does not schedule on web', async () => {
        reactNativeMock.Platform.OS = 'web';

        const scheduled = await maybeScheduleSessionEventLocalNotification(sessionEvent, { enabled: true });

        expect(scheduled).toBe(false);
        expect(notificationsMock.scheduleNotificationAsync).not.toHaveBeenCalled();
    });

    it('does not change the iOS app icon badge', async () => {
        reactNativeMock.Platform.OS = 'ios';

        await maybeScheduleSessionEventLocalNotification(sessionEvent, { enabled: true });

        const request = notificationsMock.scheduleNotificationAsync.mock.calls[0][0];
        expect(request.content).not.toHaveProperty('badge');
    });

    it('enables fallback only when notification permission exists but remote push registration is unavailable', () => {
        expect(shouldEnableSessionEventLocalNotifications({
            registered: false,
            token: null,
            permission: { status: 'granted', granted: true, canAskAgain: false },
            error: 'SERVICE_NOT_AVAILABLE',
        })).toBe(true);

        expect(shouldEnableSessionEventLocalNotifications({
            registered: true,
            token: 'ExponentPushToken[current-device]',
            permission: { status: 'granted', granted: true, canAskAgain: false },
        })).toBe(false);

        expect(shouldEnableSessionEventLocalNotifications({
            registered: false,
            token: null,
            permission: { status: 'denied', granted: false, canAskAgain: false },
        })).toBe(false);
    });

    it('keeps fallback available on native until remote push registration proves it can handle session events', () => {
        reactNativeMock.Platform.OS = 'android';
        expect(getInitialSessionEventLocalNotificationsEnabled()).toBe(true);

        reactNativeMock.Platform.OS = 'web';
        expect(getInitialSessionEventLocalNotificationsEnabled()).toBe(false);
    });
});
