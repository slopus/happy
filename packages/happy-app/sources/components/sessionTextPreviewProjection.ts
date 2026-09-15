import type { Message } from '@/sync/typesMessage';
import type { SessionTextPreview } from '@/sync/sessionTextStream';

export function selectVisibleTextPreviews(
    sessionId: string,
    isAtLatest: boolean,
    messages: readonly Message[],
    previews: readonly SessionTextPreview[],
): readonly SessionTextPreview[] {
    if (!isAtLatest) return [];
    const completed = new Set(messages.flatMap(message => (
        message.kind === 'agent-text' && !message.isThinking && message.streamKey?.itemId
            ? [JSON.stringify([message.streamKey.turnId, message.streamKey.itemId])]
            : []
    )));
    return previews.filter(preview => preview.sessionId === sessionId && preview.text.trim().length > 0
        && !completed.has(JSON.stringify([preview.turnId, preview.itemId])))
        .sort((left, right) => left.createdAt - right.createdAt);
}
