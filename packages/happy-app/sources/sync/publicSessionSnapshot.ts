import { v4 as uuid } from 'uuid';
import type { PublicSessionCover, PublicSessionSnapshotV2, PublicSessionThemePack } from '@slopus/happy-wire';
import type { Message, ToolCallMessage } from './typesMessage';
import type {
    PublicSessionAttachmentJob,
    PublicSessionAttachmentKind,
    PublicSessionMessageV1,
    PublicSessionSnapshotV1,
} from './publicSessionShareTypes';

// Keep this aligned with the authenticated renderer's hidden tools. Public
// snapshots never serialize raw tool input/result/description: those fields
// routinely contain local paths, host details, credentials, and permission
// state. The public contract exposes only the visible tool's name and status.
const HIDDEN_TOOL_NAMES = new Set([
    'CodexReasoning',
    'GeminiReasoning',
    'think',
    'change_title',
    'ToolSearch',
]);

function safeAttachmentName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) return 'attachment';
    return name.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'attachment';
}

function attachmentExtension(name: string): string {
    const basename = safeAttachmentName(name);
    const dot = basename.lastIndexOf('.');
    return dot > 0 ? basename.slice(dot).toLowerCase() : '';
}

function attachmentKind(value: unknown): PublicSessionAttachmentKind {
    return value === 'audio' || value === 'video' || value === 'file' ? value : 'image';
}

function defaultMimeType(kind: PublicSessionAttachmentKind, name: string): string {
    const extension = attachmentExtension(name);
    if (kind === 'image') {
        if (extension === '.png') return 'image/png';
        if (extension === '.gif') return 'image/gif';
        if (extension === '.webp') return 'image/webp';
        return 'image/jpeg';
    }
    if (kind === 'audio') return extension === '.wav' ? 'audio/wav' : 'audio/mpeg';
    if (kind === 'video') return extension === '.webm' ? 'video/webm' : 'video/mp4';
    if (extension === '.pdf') return 'application/pdf';
    return 'application/octet-stream';
}

function safeAttachmentSource(value: unknown): 'user' | 'generated' | 'browser_step' | undefined {
    return value === 'user' || value === 'generated' || value === 'browser_step' ? value : undefined;
}

function safeImagePresentation(value: unknown): { width: number; height: number; thumbhash?: string } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as { width?: unknown; height?: unknown; thumbhash?: unknown };
    if (
        typeof candidate.width !== 'number'
        || !Number.isFinite(candidate.width)
        || candidate.width <= 0
        || typeof candidate.height !== 'number'
        || !Number.isFinite(candidate.height)
        || candidate.height <= 0
    ) return undefined;
    const thumbhash = typeof candidate.thumbhash === 'string' && candidate.thumbhash.length <= 1_000
        ? candidate.thumbhash
        : undefined;
    return {
        width: Math.min(100_000, Math.round(candidate.width)),
        height: Math.min(100_000, Math.round(candidate.height)),
        ...(thumbhash ? { thumbhash } : {}),
    };
}

function mapFileTool(
    message: ToolCallMessage,
    attachmentByRef: Map<string, PublicSessionAttachmentJob>,
    createAttachmentId: () => string,
): { block: Extract<PublicSessionMessageV1['blocks'][number], { type: 'attachment' }>; job: PublicSessionAttachmentJob } | null {
    const input = message.tool.input;
    if (!input || typeof input !== 'object' || typeof input.ref !== 'string' || !input.ref) return null;
    const ref = input.ref;
    const source = safeAttachmentSource(input.source);
    const image = attachmentKind(input.kind) === 'image' ? safeImagePresentation(input.image) : undefined;
    const existing = attachmentByRef.get(ref);
    if (existing) {
        return {
            job: existing,
            block: {
                type: 'attachment',
                attachmentId: existing.attachmentId,
                kind: existing.kind,
                name: existing.name,
                mimeType: existing.mimeType,
                size: existing.size,
                ...(source ? { source } : {}),
                ...(image ? { image } : {}),
            },
        };
    }
    const kind = attachmentKind(input.kind);
    const name = safeAttachmentName(input.name);
    const job: PublicSessionAttachmentJob = {
        attachmentId: createAttachmentId(),
        sourceRef: ref,
        encrypted: input.encrypted !== false,
        kind,
        name,
        mimeType: typeof input.mimeType === 'string' && input.mimeType ? input.mimeType : defaultMimeType(kind, name),
        size: typeof input.size === 'number' && Number.isFinite(input.size) ? Math.max(0, Math.trunc(input.size)) : 0,
    };
    attachmentByRef.set(ref, job);
    return {
        job,
        block: {
            type: 'attachment',
            attachmentId: job.attachmentId,
            kind: job.kind,
            name: job.name,
            mimeType: job.mimeType,
            size: job.size,
            ...(source ? { source } : {}),
            ...(image ? { image } : {}),
        },
    };
}

export function buildPublicSessionSnapshot(input: {
    title: string;
    messages: Message[];
    sharedAt: number;
    themePack: PublicSessionThemePack;
    cover?: PublicSessionCover;
    groupToolCalls?: boolean;
    createAttachmentId?: () => string;
}): { snapshot: PublicSessionSnapshotV2; attachments: PublicSessionAttachmentJob[] } {
    const createAttachmentId = input.createAttachmentId ?? uuid;
    const attachmentByRef = new Map<string, PublicSessionAttachmentJob>();
    const publicMessages: PublicSessionMessageV1[] = [];
    const addMessage = (message: Omit<PublicSessionMessageV1, 'id'>) => {
        publicMessages.push({ id: `message-${publicMessages.length + 1}`, ...message });
    };

    const visit = (message: Message) => {
        if (message.kind === 'user-text') {
            const markdown = (message.displayText ?? message.text).trim();
            if (markdown) addMessage({ role: 'user', createdAt: message.createdAt, blocks: [{ type: 'text', markdown }] });
            return;
        }
        if (message.kind === 'agent-text') {
            const markdown = message.text.trim();
            if (markdown) {
                addMessage({
                    role: 'assistant',
                    createdAt: message.createdAt,
                    blocks: [{ type: message.isThinking ? 'thinking' : 'text', markdown }],
                });
            }
            return;
        }
        if (message.kind === 'agent-event') {
            const event = message.event;
            if (event.type === 'message' && event.message.trim()) {
                addMessage({ role: 'system', createdAt: message.createdAt, blocks: [{ type: 'text', markdown: event.message.trim() }] });
            }
            return;
        }

        if (message.tool.name === 'file') {
            const mapped = mapFileTool(message, attachmentByRef, createAttachmentId);
            if (mapped) {
                addMessage({ role: 'assistant', createdAt: message.createdAt, blocks: [mapped.block] });
            }
        } else if (!HIDDEN_TOOL_NAMES.has(message.tool.name)) {
            addMessage({
                role: 'assistant',
                createdAt: message.createdAt,
                blocks: [{
                    type: 'tool',
                    name: message.tool.name,
                    status: message.tool.state === 'error' ? 'failed' : message.tool.state,
                }],
            });
        }
        for (const child of message.children) visit(child);
    };

    for (const message of input.messages) visit(message);
    return {
        snapshot: {
            version: 2,
            title: input.title.trim() || 'Shared session',
            sharedAt: input.sharedAt,
            presentation: { groupToolCalls: input.groupToolCalls ?? true },
            appearance: {
                themePack: input.themePack,
                ...(input.cover ? { cover: input.cover } : {}),
            },
            messages: publicMessages,
        },
        attachments: Array.from(attachmentByRef.values()),
    };
}
