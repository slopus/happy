import { describe, expect, it } from 'vitest';
import type { PendingMessage } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';
import { buildChatListItems } from './chatListItems';

describe('buildChatListItems', () => {
    it('prepends pending messages before transcript messages', () => {
        const messages: Message[] = [
            { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'agent' },
            { kind: 'user-text', id: 'm1', localId: 'u1', createdAt: 1, text: 'user' },
        ];
        const pending: PendingMessage[] = [
            { id: 'p1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'pending 1', rawRecord: {} as any },
            { id: 'p2', localId: 'p2', createdAt: 11, updatedAt: 11, text: 'pending 2', rawRecord: {} as any },
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });

        expect(items.map((i) => i.kind)).toEqual(['pending-user-text', 'pending-user-text', 'message', 'message']);
        expect(items[0]?.kind === 'pending-user-text' && items[0].pending.localId).toBe('p1');
        expect(items[1]?.kind === 'pending-user-text' && items[1].pending.localId).toBe('p2');
        expect(items[2]?.kind === 'message' && items[2].message.id).toBe('m2');
        expect(items[3]?.kind === 'message' && items[3].message.id).toBe('m1');
    });

    it('drops pending messages that are already materialized in the transcript', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'm1', localId: 'p1', createdAt: 20, text: 'materialized' },
        ];
        const pending: PendingMessage[] = [
            { id: 'p1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'pending 1', rawRecord: {} as any },
            { id: 'p2', localId: 'p2', createdAt: 11, updatedAt: 11, text: 'pending 2', rawRecord: {} as any },
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });

        expect(items.map((i) => (i.kind === 'pending-user-text' ? i.pending.localId : i.message.id))).toEqual(['p2', 'm1']);
    });

    it('sets otherPendingCount only for the next pending message', () => {
        const messages: Message[] = [];
        const pending: PendingMessage[] = [
            { id: 'p1', localId: 'p1', createdAt: 10, updatedAt: 10, text: 'pending 1', rawRecord: {} as any },
            { id: 'p2', localId: 'p2', createdAt: 11, updatedAt: 11, text: 'pending 2', rawRecord: {} as any },
            { id: 'p3', localId: 'p3', createdAt: 12, updatedAt: 12, text: 'pending 3', rawRecord: {} as any },
        ];

        const items = buildChatListItems({ messages, pendingMessages: pending });

        expect(items[0]?.kind === 'pending-user-text' && items[0].otherPendingCount).toBe(2);
        expect(items[1]?.kind === 'pending-user-text' && items[1].otherPendingCount).toBe(0);
        expect(items[2]?.kind === 'pending-user-text' && items[2].otherPendingCount).toBe(0);
    });
});

