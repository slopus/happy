import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock react-native and device-info (transitive deps via platform.ts)
vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (obj: any) => obj.default },
}));
vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

// Mock Tauri APIs
const mockInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
    invoke: (...args: any[]) => mockInvoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
    listen: vi.fn(),
}));

// Set __TAURI_INTERNALS__ to make isTauri() return true
(global as any).window = { __TAURI_INTERNALS__: {} };

// Mock document for hasFocus
const mockHasFocus = vi.fn(() => false);
(global as any).document = { hasFocus: mockHasFocus };

import {
    sendDesktopNotification,
    onSyncUpdate,
    DEDUP_WINDOW_MS,
    lastNotificationTime,
} from './tauriNotifications';

describe('tauriNotifications', () => {
    beforeEach(() => {
        mockInvoke.mockClear();
        lastNotificationTime.clear();
        mockHasFocus.mockReturnValue(false);
    });

    describe('sendDesktopNotification', () => {
        it('calls invoke with correct args', async () => {
            await sendDesktopNotification('Title', 'Body', 'sess1', '/session/sess1');
            expect(mockInvoke).toHaveBeenCalledWith('send_notification', {
                title: 'Title',
                body: 'Body',
                route: '/session/sess1',
            });
        });

        it('suppresses when window is focused', async () => {
            mockHasFocus.mockReturnValue(true);
            await sendDesktopNotification('Title', 'Body');
            expect(mockInvoke).not.toHaveBeenCalled();
        });

        it('deduplicates same session within 5s', async () => {
            await sendDesktopNotification('T1', 'B1', 'sess1');
            await sendDesktopNotification('T2', 'B2', 'sess1');
            expect(mockInvoke).toHaveBeenCalledTimes(1);
        });

        it('allows notification after dedup window expires', async () => {
            await sendDesktopNotification('T1', 'B1', 'sess1');
            // Simulate time passing
            lastNotificationTime.set('sess1', Date.now() - DEDUP_WINDOW_MS - 1);
            await sendDesktopNotification('T2', 'B2', 'sess1');
            expect(mockInvoke).toHaveBeenCalledTimes(2);
        });

        it('does not dedup different sessions', async () => {
            await sendDesktopNotification('T1', 'B1', 'sess1');
            await sendDesktopNotification('T2', 'B2', 'sess2');
            expect(mockInvoke).toHaveBeenCalledTimes(2);
        });

        it('passes null route when not provided', async () => {
            await sendDesktopNotification('T', 'B');
            expect(mockInvoke).toHaveBeenCalledWith('send_notification', {
                title: 'T',
                body: 'B',
                route: null,
            });
        });
    });

    describe('onSyncUpdate', () => {
        it('sends notification for permission request (agentState non-null)', async () => {
            onSyncUpdate('update-session', {
                sessionId: 's1',
                sessionName: 'My Session',
                agentState: { type: 'permission' },
            });
            // Give async sendDesktopNotification time to resolve
            await vi.waitFor(() => {
                expect(mockInvoke).toHaveBeenCalledWith('send_notification', expect.objectContaining({
                    title: 'Permission request',
                }));
            });
        });

        it('does NOT send notification when agentState is null', () => {
            onSyncUpdate('update-session', {
                sessionId: 's1',
                agentState: null,
            });
            // No async, should not have been called
            expect(mockInvoke).not.toHaveBeenCalled();
        });

        it('sends notification for friend request', async () => {
            onSyncUpdate('relationship-updated', {});
            await vi.waitFor(() => {
                expect(mockInvoke).toHaveBeenCalledWith('send_notification', expect.objectContaining({
                    title: 'Friend request',
                }));
            });
        });
    });
});
