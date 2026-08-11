import type { Message, UserTextMessage } from '@/sync/typesMessage';

export type MessageForkTarget = {
    messageId: string;
    messageText: string;
    rewindPointId: string | undefined;
};

type RewindPointCandidate = {
    id: string;
    text: string;
};

/**
 * Messages are newest-first. Walking from oldest to newest keeps the latest
 * user prompt in hand, so each visible agent response can fork its full turn.
 */
export function getAgentMessageForkTargets(
    messages: Message[],
    options: { allowMissingRewindPoint?: boolean } = {},
): Map<string, MessageForkTarget> {
    const targets = new Map<string, MessageForkTarget>();
    let currentUserMessage: UserTextMessage | null = null;

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.kind === 'user-text') {
            currentUserMessage = message;
            continue;
        }
        if (message.kind !== 'agent-text' || message.isThinking || !currentUserMessage) {
            continue;
        }

        const rewindPointId = currentUserMessage.claudeUuid ?? currentUserMessage.codexItemId;
        if (!rewindPointId && !options.allowMissingRewindPoint) {
            continue;
        }

        targets.set(message.id, {
            messageId: message.id,
            messageText: currentUserMessage.text,
            rewindPointId,
        });
    }

    return targets;
}

export function resolveInitialForkRewindPointId(
    points: RewindPointCandidate[],
    initialRewindPointId: string | undefined,
    initialMessageText: string | undefined,
    allowMessageTextFallback: boolean,
): string | null {
    if (initialRewindPointId) {
        return points.some((point) => point.id === initialRewindPointId)
            ? initialRewindPointId
            : null;
    }
    if (!allowMessageTextFallback || !initialMessageText) {
        return null;
    }

    const target = normalizeMessageText(initialMessageText);
    return points.find((point) => normalizeMessageText(point.text) === target)?.id ?? null;
}

function normalizeMessageText(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}
