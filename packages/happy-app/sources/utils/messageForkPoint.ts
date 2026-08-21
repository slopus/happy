import type { Message, UserTextMessage } from '@/sync/typesMessage';

export type MessageForkTarget = {
    messageId: string;
    messageText: string;
    messageCreatedAt: number;
    rewindPointId: string | undefined;
};

export type MessageForkFlavor = 'claude' | 'codex';

export function getUserMessageForkRewindPointId(
    message: Pick<UserTextMessage, 'claudeUuid' | 'codexItemId'>,
    flavor: MessageForkFlavor,
): string | undefined {
    return flavor === 'codex' ? message.codexItemId : message.claudeUuid;
}

export type DirectMessageForkOptions = {
    cutAfterUuid?: string;
    cutAfterItemId?: string;
    forkedFromMessageId: string;
    retainSelectedTurn?: boolean;
};

export function buildDirectMessageForkOptions(
    flavor: 'claude' | 'codex',
    target: Pick<MessageForkTarget, 'messageId' | 'rewindPointId'> & { retainSelectedTurn?: boolean },
): DirectMessageForkOptions | null {
    if (!target.rewindPointId) {
        return null;
    }

    if (flavor === 'codex') {
        return {
            cutAfterItemId: target.rewindPointId,
            forkedFromMessageId: target.messageId,
            retainSelectedTurn: target.retainSelectedTurn,
        };
    }

    return {
        cutAfterUuid: target.rewindPointId,
        forkedFromMessageId: target.messageId,
    };
}

type RewindPointCandidate = {
    id: string;
    text: string;
};

type CodexRewindPointCandidate = {
    itemId: string;
    text: string;
    timestamp: number;
};

const MAX_CODEX_REWIND_TIMESTAMP_DISTANCE_MS = 5 * 60 * 1000;

/**
 * Messages are newest-first. Walking from oldest to newest keeps the latest
 * user prompt in hand, so each visible agent response can fork its full turn.
 */
export function getAgentMessageForkTargets(
    messages: Message[],
    options: { flavor?: MessageForkFlavor; allowMissingRewindPoint?: boolean } = {},
): Map<string, MessageForkTarget> {
    const targets = new Map<string, MessageForkTarget>();
    let currentUserMessage: UserTextMessage | null = null;
    const flavor = options.flavor ?? 'claude';

    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.kind === 'user-text') {
            currentUserMessage = message;
            continue;
        }
        if (message.kind !== 'agent-text' || message.isThinking || !currentUserMessage) {
            continue;
        }

        const rewindPointId = getUserMessageForkRewindPointId(currentUserMessage, flavor);
        if (!rewindPointId && !options.allowMissingRewindPoint) {
            continue;
        }

        targets.set(message.id, {
            messageId: message.id,
            messageText: currentUserMessage.text,
            messageCreatedAt: currentUserMessage.createdAt,
            rewindPointId,
        });
    }

    return targets;
}

/**
 * Live Codex user envelopes can arrive before their provider item id. Resolve
 * the clicked turn without a picker: accept only exact text or an explicitly
 * wrapped prompt suffix, then disambiguate by the provider turn timestamp.
 * Every inferred match must be fresh and unambiguous so a stale thread
 * snapshot can never silently fork a neighbouring turn.
 */
export function resolveCodexMessageForkRewindPointId(
    points: CodexRewindPointCandidate[],
    target: Pick<MessageForkTarget, 'messageText' | 'messageCreatedAt' | 'rewindPointId'>,
): string | null {
    if (target.rewindPointId) {
        return target.rewindPointId;
    }

    const normalizedTargetText = normalizeMessageText(target.messageText);
    if (!normalizedTargetText || !Number.isFinite(target.messageCreatedAt)) {
        return null;
    }

    const exactTextMatches = points.filter(
        (point) => normalizeMessageText(point.text) === normalizedTargetText,
    );
    const wrappedTextMatches = exactTextMatches.length === 0
        ? points.filter((point) => {
            const normalizedPointText = normalizeMessageText(point.text);
            return normalizedPointText.endsWith(` ${normalizedTargetText}`);
        })
        : [];
    const candidates = exactTextMatches.length > 0 ? exactTextMatches : wrappedTextMatches;
    if (candidates.length === 0) {
        return null;
    }

    const byTimestampDistance = candidates
        .map((point) => ({
            itemId: point.itemId,
            distance: Math.abs(point.timestamp - target.messageCreatedAt),
        }))
        .filter((candidate) => Number.isFinite(candidate.distance))
        .sort((left, right) => left.distance - right.distance);
    const closest = byTimestampDistance[0];
    if (!closest || closest.distance > MAX_CODEX_REWIND_TIMESTAMP_DISTANCE_MS) {
        return null;
    }
    if (byTimestampDistance[1]?.distance === closest.distance) {
        return null;
    }
    return closest.itemId;
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
