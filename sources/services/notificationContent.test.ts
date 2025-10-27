import { describe, it, expect } from 'vitest';
import { getSessionDisplayName, generateNotificationContent } from './notificationContent';
import { Session } from '@/sync/storageTypes';

// Mock session factory
function createMockSession(overrides?: Partial<Session>): Session {
    return {
        id: 'abc123def456',
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

describe('notificationContent', () => {
    describe('getSessionDisplayName', () => {
        it('should use session name if available', () => {
            const session = createMockSession({
                metadata: {
                    path: '/test',
                    host: 'localhost',
                    name: 'My Project',
                },
            });

            expect(getSessionDisplayName(session)).toBe('My Project');
        });

        it('should use session summary if no name', () => {
            const session = createMockSession({
                metadata: {
                    path: '/test',
                    host: 'localhost',
                    summary: {
                        text: 'Help me with data analysis',
                        updatedAt: Date.now(),
                    },
                },
            });

            expect(getSessionDisplayName(session)).toBe('Help me with data analysis');
        });

        it('should truncate long summary with ellipsis', () => {
            const session = createMockSession({
                metadata: {
                    path: '/test',
                    host: 'localhost',
                    summary: {
                        text: 'This is a very long summary text that should be truncated',
                        updatedAt: Date.now(),
                    },
                },
            });

            const result = getSessionDisplayName(session);
            expect(result).toBe('This is a very long summary ...');
            expect(result.length).toBe(33); // 30 chars + '...'
        });

        it('should use session ID if no name or summary', () => {
            const session = createMockSession({
                id: 'abc123def456',
            });

            expect(getSessionDisplayName(session)).toBe('Session abc123de');
        });

        it('should handle null metadata', () => {
            const session = createMockSession({
                id: 'xyz789',
                metadata: null,
            });

            expect(getSessionDisplayName(session)).toBe('Session xyz789');
        });
    });

    describe('generateNotificationContent', () => {
        const mockSession = createMockSession({
            metadata: {
                path: '/test',
                host: 'localhost',
                name: 'Test Project',
            },
        });

        describe('permission notifications', () => {
            it('should generate permission notification with reason', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'permission',
                    permissionName: 'file_system',
                    permissionReason: 'read configuration files',
                });

                expect(result.title).toContain('Test Project');
                expect(result.title).toContain('needs permission');
                expect(result.body).toContain('file_system');
                expect(result.body).toContain('read configuration files');
            });

            it('should generate permission notification without reason', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'permission',
                    permissionName: 'network_access',
                });

                expect(result.title).toContain('Test Project');
                expect(result.body).toContain('network_access');
            });

            it('should handle unknown permission', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'permission',
                });

                expect(result.body).toContain('unknown permission');
            });

            it('should truncate long session names in title', () => {
                const longNameSession = createMockSession({
                    metadata: {
                        path: '/test',
                        host: 'localhost',
                        name: 'This is a very long project name that exceeds twenty characters',
                    },
                });

                const result = generateNotificationContent({
                    session: longNameSession,
                    type: 'permission',
                    permissionName: 'file_system',
                });

                // Should be truncated to 20 chars + '...'
                expect(result.title.length).toBeLessThan(50);
                expect(result.title).toContain('...');
            });
        });

        describe('input required notifications', () => {
            it('should generate input notification with custom message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'input',
                    customMessage: 'Data cleaning completed',
                });

                expect(result.title).toContain('Test Project');
                expect(result.title).toContain('waiting');
                expect(result.body).toBe('Data cleaning completed');
            });

            it('should generate input notification with default message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'input',
                });

                expect(result.title).toContain('Test Project');
                expect(result.body).toContain('command');
            });
        });

        describe('completion notifications', () => {
            it('should generate completion notification with custom message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'completion',
                    customMessage: 'Refactored 10 files successfully',
                });

                expect(result.title).toContain('Test Project');
                expect(result.title).toContain('completed');
                expect(result.body).toBe('Refactored 10 files successfully');
            });

            it('should generate completion notification with default message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'completion',
                });

                expect(result.title).toContain('Test Project');
                expect(result.body).toContain('Task completed');
            });
        });

        describe('error notifications', () => {
            it('should generate error notification with custom message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'error',
                    customMessage: 'Network connection failed',
                });

                expect(result.title).toContain('Test Project');
                expect(result.title).toContain('error');
                expect(result.body).toBe('Network connection failed');
            });

            it('should generate error notification with default message', () => {
                const result = generateNotificationContent({
                    session: mockSession,
                    type: 'error',
                });

                expect(result.title).toContain('Test Project');
                expect(result.body).toContain('unknown error');
            });
        });

        describe('all notification types', () => {
            it('should include session name in all notification titles', () => {
                const types: Array<'permission' | 'input' | 'completion' | 'error'> = [
                    'permission',
                    'input',
                    'completion',
                    'error',
                ];

                types.forEach((type) => {
                    const result = generateNotificationContent({
                        session: mockSession,
                        type,
                    });

                    expect(result.title).toContain('Test Project');
                });
            });

            it('should have non-empty body for all notification types', () => {
                const types: Array<'permission' | 'input' | 'completion' | 'error'> = [
                    'permission',
                    'input',
                    'completion',
                    'error',
                ];

                types.forEach((type) => {
                    const result = generateNotificationContent({
                        session: mockSession,
                        type,
                    });

                    expect(result.body.length).toBeGreaterThan(0);
                });
            });
        });
    });
});
