import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storage } from '@/sync/storage';
import { Sync } from '@/sync/sync';

describe('Active Session Navigation - Message Loading', () => {
    let mockSync: Sync;

    beforeEach(() => {
        storage.getState().clearAll();
        mockSync = new Sync();
    });

    describe('NEW SESSION cases', () => {
        it('should set isLoaded flag for new session with messages', async () => {
            const sessionId = 'new-session-with-messages';

            // Simulate CLI session with 50 existing messages
            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: Array.from({ length: 50 }, (_, i) => ({
                    id: `msg-${i}`,
                    sessionId,
                    type: 'user-text',
                    text: `Message ${i}`,
                    createdAt: Date.now() - (50 - i) * 1000
                }))
            });

            await mockSync['fetchMessages'](sessionId);

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages).toBeDefined();
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(50);
        });

        it('should set isLoaded flag for empty new session', async () => {
            const sessionId = 'new-empty-session';

            // Simulate brand new CLI session with no messages
            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: []
            });

            await mockSync['fetchMessages'](sessionId);

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(0);
        });

        it('should process AgentState for new session with pending permissions', async () => {
            const sessionId = 'new-session-with-permissions';

            // Set up session with AgentState (pending permission requests)
            storage.getState().updateSession({
                id: sessionId,
                agentState: {
                    version: 1,
                    requests: [
                        {
                            id: 'req-1',
                            type: 'edit',
                            status: 'pending',
                            path: '/test/file.ts'
                        }
                    ],
                    controlledByUser: false
                }
            });

            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: []
            });

            await mockSync['fetchMessages'](sessionId);

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages.length).toBeGreaterThan(0); // Permission message added
        });
    });

    describe('EXISTING SESSION cases', () => {
        it('should handle reconnection to already-loaded session', async () => {
            const sessionId = 'existing-session';

            // First load
            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: [
                    { id: 'msg-1', sessionId, type: 'user-text', text: 'First', createdAt: Date.now() }
                ]
            });
            await mockSync['fetchMessages'](sessionId);

            // Verify first load
            let sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(1);

            // Second load (reconnection)
            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: [
                    { id: 'msg-1', sessionId, type: 'user-text', text: 'First', createdAt: Date.now() },
                    { id: 'msg-2', sessionId, type: 'user-text', text: 'Second', createdAt: Date.now() }
                ]
            });
            await mockSync['fetchMessages'](sessionId);

            // Verify second load
            sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(2);
        });

        it('should be idempotent when called multiple times', async () => {
            const sessionId = 'idempotent-test';

            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: [
                    { id: 'msg-1', sessionId, type: 'user-text', text: 'Test', createdAt: Date.now() }
                ]
            });

            // Call three times rapidly
            await mockSync['fetchMessages'](sessionId);
            await mockSync['fetchMessages'](sessionId);
            await mockSync['fetchMessages'](sessionId);

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(1); // Not duplicated
        });
    });

    describe('EDGE CASES', () => {
        it('should handle large message history (100+ messages)', async () => {
            const sessionId = 'large-history';

            vi.spyOn(mockSync['api'], 'messages').mockResolvedValue({
                messages: Array.from({ length: 150 }, (_, i) => ({
                    id: `msg-${i}`,
                    sessionId,
                    type: 'user-text',
                    text: `Message ${i}`,
                    createdAt: Date.now() - (150 - i) * 1000
                }))
            });

            await mockSync['fetchMessages'](sessionId);

            const sessionMessages = storage.getState().sessionMessages[sessionId];
            expect(sessionMessages.isLoaded).toBe(true);
            expect(sessionMessages.messages).toHaveLength(150);
        });
    });
});
