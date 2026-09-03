import type { Message, ToolCall } from './typesMessage';
import type {
    PublicSessionBlockV1,
    PublicSessionMessageV1,
    PublicSessionSnapshot,
} from './publicSessionShareTypes';

export const PUBLIC_SESSION_ATTACHMENT_REF_PREFIX = 'public-session-attachment:';

export function publicSessionAttachmentRef(attachmentId: string): string {
    return `${PUBLIC_SESSION_ATTACHMENT_REF_PREFIX}${attachmentId}`;
}

export function publicSessionAttachmentIdFromRef(ref: string): string | null {
    return ref.startsWith(PUBLIC_SESSION_ATTACHMENT_REF_PREFIX)
        ? ref.slice(PUBLIC_SESSION_ATTACHMENT_REF_PREFIX.length)
        : null;
}

function toolState(status: Extract<PublicSessionBlockV1, { type: 'tool' }>['status']): ToolCall['state'] {
    return status === 'failed' ? 'error' : status;
}

function messageId(message: PublicSessionMessageV1, blockIndex: number): string {
    return message.blocks.length === 1 ? message.id : `${message.id}-block-${blockIndex + 1}`;
}

function adaptBlock(
    message: PublicSessionMessageV1,
    block: PublicSessionBlockV1,
    blockIndex: number,
    attachmentUrl: ((attachmentId: string) => string) | undefined,
): Message | null {
    const id = messageId(message, blockIndex);
    if (block.type === 'text') {
        if (message.role === 'user') {
            return {
                kind: 'user-text',
                id,
                localId: null,
                createdAt: message.createdAt,
                text: block.markdown,
            };
        }
        if (message.role === 'system') {
            return {
                kind: 'agent-event',
                id,
                createdAt: message.createdAt,
                event: { type: 'message', message: block.markdown },
            };
        }
        return {
            kind: 'agent-text',
            id,
            localId: null,
            createdAt: message.createdAt,
            text: block.markdown,
        };
    }
    if (block.type === 'thinking') {
        return {
            kind: 'agent-text',
            id,
            localId: null,
            createdAt: message.createdAt,
            text: block.markdown,
            isThinking: true,
        };
    }
    if (block.type === 'attachment') {
        return {
            kind: 'tool-call',
            id,
            localId: null,
            createdAt: message.createdAt,
            tool: {
                name: 'file',
                state: 'completed',
                input: {
                    ref: attachmentUrl?.(block.attachmentId) ?? publicSessionAttachmentRef(block.attachmentId),
                    name: block.name,
                    size: block.size,
                    kind: block.kind,
                    mimeType: block.mimeType,
                    encrypted: false,
                    source: block.source ?? 'user',
                    ...(block.image ? { image: block.image } : {}),
                },
                createdAt: message.createdAt,
                startedAt: message.createdAt,
                completedAt: message.createdAt,
                description: null,
            },
            children: [],
        };
    }
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: message.createdAt,
        tool: {
            name: block.name,
            state: toolState(block.status),
            input: {},
            result: block.body,
            createdAt: message.createdAt,
            startedAt: message.createdAt,
            completedAt: block.status === 'running' ? null : message.createdAt,
            description: block.title ?? null,
        },
        children: [],
    };
}

/**
 * Public snapshots store messages newest-first, matching the authenticated
 * conversation store. Blocks inside one snapshot message are display-order,
 * so reverse those blocks when expanding them into the inverted list model.
 */
export function publicSessionSnapshotToMessages(
    snapshot: PublicSessionSnapshot,
    options: { attachmentUrl?: (attachmentId: string) => string } = {},
): Message[] {
    const messages: Message[] = [];
    for (const message of snapshot.messages) {
        for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
            const adapted = adaptBlock(message, message.blocks[blockIndex], blockIndex, options.attachmentUrl);
            if (adapted) messages.push(adapted);
        }
    }
    return messages;
}
