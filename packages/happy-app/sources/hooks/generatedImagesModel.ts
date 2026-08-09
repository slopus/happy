import type { Message } from '@/sync/typesMessage';

export type GeneratedImageEntry = {
    id: string;
    sessionId: string;
    sessionTitle: string;
    messageId: string;
    ref: string;
    name: string;
    createdAt: number;
    prompt?: string;
    batchId?: string;
    localPath?: string;
    width?: number;
    height?: number;
    thumbhash?: string;
};

type FileImageInput = {
    ref: string;
    name?: string;
    source?: 'user' | 'generated';
    prompt?: string;
    batchId?: string;
    localPath?: string;
    image?: {
        width?: number;
        height?: number;
        thumbhash?: string;
    };
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGeneratedImageInput(input: unknown): FileImageInput | null {
    if (!isRecord(input)) return null;
    const ref = typeof input.ref === 'string' ? input.ref : null;
    if (!ref) return null;
    const image = isRecord(input.image) ? input.image : undefined;
    const name = typeof input.name === 'string' ? input.name : undefined;
    if (!isGeneratedImageFileInput({ ...input, name, image })) return null;
    return {
        ref,
        name,
        source: input.source === 'generated' ? 'generated' : undefined,
        prompt: typeof input.prompt === 'string' ? input.prompt : undefined,
        batchId: typeof input.batchId === 'string' ? input.batchId : undefined,
        localPath: typeof input.localPath === 'string' ? input.localPath : undefined,
        image: image ? {
            width: typeof image.width === 'number' ? image.width : undefined,
            height: typeof image.height === 'number' ? image.height : undefined,
            thumbhash: typeof image.thumbhash === 'string' ? image.thumbhash : undefined,
        } : undefined,
    };
}

export function isGeneratedImageFileInput(input: unknown): boolean {
    if (!isRecord(input)) return false;
    if (input.source === 'generated') return true;
    if (typeof input.prompt === 'string' && input.prompt.trim()) return true;
    if (typeof input.batchId === 'string' && input.batchId.trim()) return true;
    if (typeof input.localPath === 'string' && input.localPath.includes('/generated-images/')) return true;
    return isRecord(input.image)
        && typeof input.name === 'string'
        && /gpt[-_\s]?image[-_\s]?2/i.test(input.name);
}

export function collectGeneratedImagesFromMessages(sessionId: string, title: string, messages: Message[]): GeneratedImageEntry[] {
    const entries: GeneratedImageEntry[] = [];
    for (const message of messages) {
        if (message.kind !== 'tool-call' || message.tool.name !== 'file') continue;
        const parsed = parseGeneratedImageInput(message.tool.input);
        if (!parsed) continue;
        entries.push({
            id: `${sessionId}:${message.id}`,
            sessionId,
            sessionTitle: title,
            messageId: message.id,
            ref: parsed.ref,
            name: parsed.name || 'image.png',
            createdAt: message.createdAt,
            ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
            ...(parsed.batchId ? { batchId: parsed.batchId } : {}),
            ...(parsed.localPath ? { localPath: parsed.localPath } : {}),
            ...(parsed.image?.width !== undefined ? { width: parsed.image.width } : {}),
            ...(parsed.image?.height !== undefined ? { height: parsed.image.height } : {}),
            ...(parsed.image?.thumbhash !== undefined ? { thumbhash: parsed.image.thumbhash } : {}),
        });
    }
    return entries;
}
