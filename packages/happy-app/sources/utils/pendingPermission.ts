import type { Message } from '@/sync/typesMessage';

export function findPendingPermissionMessageId(messages: readonly Message[]): string | null {
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message?.kind === 'tool-call' && message.tool.permission?.status === 'pending') {
            return message.id;
        }
    }
    return null;
}

export async function loadPendingPermissionMessageId(args: {
    ensureLoaded: () => Promise<void>;
    getMessages: () => readonly Message[];
}): Promise<string | null> {
    try {
        await args.ensureLoaded();
        return findPendingPermissionMessageId(args.getMessages());
    } catch {
        return null;
    }
}
