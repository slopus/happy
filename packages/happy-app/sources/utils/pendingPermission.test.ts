import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { findPendingPermissionMessageId, loadPendingPermissionMessageId } from './pendingPermission';

describe('findPendingPermissionMessageId', () => {
    it('returns the newest normalized pending tool message id, not the permission request id', () => {
        const messages = [
            {
                kind: 'tool-call',
                id: 'message-older',
                localId: null,
                createdAt: 1,
                tool: {
                    name: 'Bash', state: 'running', input: {}, createdAt: 1, startedAt: 1, completedAt: null,
                    description: null, permission: { id: 'request-older', status: 'pending' },
                },
                children: [],
            },
            {
                kind: 'tool-call',
                id: 'message-newer',
                localId: null,
                createdAt: 2,
                tool: {
                    name: 'Write', state: 'running', input: {}, createdAt: 2, startedAt: 2, completedAt: null,
                    description: null, permission: { id: 'request-newer', status: 'pending' },
                },
                children: [],
            },
        ] satisfies Message[];

        expect(findPendingPermissionMessageId(messages)).toBe('message-newer');
    });

    it('returns null when every permission is already resolved', () => {
        expect(findPendingPermissionMessageId([])).toBeNull();
    });

    it('falls back when message loading fails', async () => {
        expect(await loadPendingPermissionMessageId({
            ensureLoaded: async () => { throw new Error('offline'); },
            getMessages: () => { throw new Error('must not read after a load failure'); },
        })).toBeNull();
    });

    it('falls back when loading succeeds without a pending tool message', async () => {
        expect(await loadPendingPermissionMessageId({
            ensureLoaded: async () => {},
            getMessages: () => [],
        })).toBeNull();
    });
});
