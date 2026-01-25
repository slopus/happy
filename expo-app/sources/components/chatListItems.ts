import type { PendingMessage } from '@/sync/storageTypes';
import type { Message } from '@/sync/typesMessage';

export type ChatListItem =
    | {
        kind: 'message';
        id: string;
        message: Message;
    }
    | {
        kind: 'pending-user-text';
        id: string;
        pending: PendingMessage;
        otherPendingCount: number;
    };

export function buildChatListItems(opts: {
    messages: Message[];
    pendingMessages: PendingMessage[];
}): ChatListItem[] {
    const localIdsInTranscript = new Set<string>();
    for (const m of opts.messages) {
        if ('localId' in m && m.localId) {
            localIdsInTranscript.add(m.localId);
        }
    }

    const pending = opts.pendingMessages.filter((p) => !p.localId || !localIdsInTranscript.has(p.localId));
    const items: ChatListItem[] = [];

    for (let i = 0; i < pending.length; i++) {
        const p = pending[i]!;
        const pendingId =
            typeof p.localId === 'string' && p.localId.length > 0
                ? p.localId
                : `fallback-${i}`;
        items.push({
            kind: 'pending-user-text',
            id: `pending:${pendingId}`,
            pending: p,
            otherPendingCount: i === 0 ? Math.max(0, pending.length - 1) : 0,
        });
    }

    for (const m of opts.messages) {
        items.push({
            kind: 'message',
            id: m.id,
            message: m,
        });
    }

    return items;
}
