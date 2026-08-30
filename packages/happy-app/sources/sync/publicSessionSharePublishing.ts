import type { Message } from './typesMessage';
import { buildPublicSessionSnapshot } from './publicSessionSnapshot';
import type { PublicSessionAttachmentJob, PublicSessionSnapshotV1 } from './publicSessionShareTypes';
import type { PreparedPublicSessionShareAsset } from './apiPublicSessionShares';

type MessagePageState = { messages: Message[]; hasMoreOlder: boolean } | undefined;

export async function loadCompleteSessionMessages(sessionId: string, deps: {
    ensureMessagesLoaded: (sessionId: string) => Promise<void>;
    loadOlderMessages: (sessionId: string) => Promise<void>;
    getMessageState: () => MessagePageState;
}): Promise<Message[]> {
    await deps.ensureMessagesLoaded(sessionId);
    let previousOldestId: string | null = null;
    for (let page = 0; page < 10_000; page += 1) {
        const state = deps.getMessageState();
        if (!state?.hasMoreOlder) return state?.messages ?? [];
        const oldestId = state.messages[0]?.id ?? null;
        await deps.loadOlderMessages(sessionId);
        const nextState = deps.getMessageState();
        if (nextState?.hasMoreOlder && nextState.messages[0]?.id === oldestId && previousOldestId === oldestId) {
            throw new Error('Unable to load complete session history');
        }
        previousOldestId = oldestId;
    }
    throw new Error('Session history exceeds the supported page count');
}

export type PublicSessionPublishDependencies = {
    loadMessages: () => Promise<Message[]>;
    createDraft: () => Promise<{ generation: string; publicId: string }>;
    loadAttachmentBytes: (asset: PublicSessionAttachmentJob) => Promise<Uint8Array>;
    prepareAsset: (generation: string, asset: PublicSessionAttachmentJob, sha256: string) => Promise<PreparedPublicSessionShareAsset>;
    uploadAsset: (upload: PreparedPublicSessionShareAsset, bytes: Uint8Array) => Promise<void>;
    publishDraft: (generation: string, snapshot: PublicSessionSnapshotV1) => Promise<{ publicId: string; publishedAt: number }>;
    createAttachmentId?: () => string;
    hashAttachmentBytes?: (bytes: Uint8Array) => Promise<string>;
    onProgress?: (completed: number, total: number) => void;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const Crypto = await import('expo-crypto');
    const digestInput = new Uint8Array(bytes.length);
    digestInput.set(bytes);
    const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestInput));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replaceAttachmentSize(snapshot: PublicSessionSnapshotV1, attachmentId: string, size: number): void {
    for (const message of snapshot.messages) {
        for (const block of message.blocks) {
            if (block.type === 'attachment' && block.attachmentId === attachmentId) block.size = size;
        }
    }
}

export async function publishPublicSessionSnapshot(
    input: { sessionId: string; title: string; sharedAt: number; groupToolCalls?: boolean },
    deps: PublicSessionPublishDependencies,
): Promise<{ publicId: string; publishedAt: number }> {
    const messages = await deps.loadMessages();
    const { snapshot, attachments } = buildPublicSessionSnapshot({
        title: input.title,
        messages,
        sharedAt: input.sharedAt,
        groupToolCalls: input.groupToolCalls,
        createAttachmentId: deps.createAttachmentId,
    });
    const draft = await deps.createDraft();
    deps.onProgress?.(0, attachments.length);
    for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index];
        const bytes = await deps.loadAttachmentBytes(attachment);
        if (attachment.size !== bytes.length) {
            attachment.size = bytes.length;
            replaceAttachmentSize(snapshot, attachment.attachmentId, bytes.length);
        }
        const sha256 = await (deps.hashAttachmentBytes ?? sha256Hex)(bytes);
        const upload = await deps.prepareAsset(draft.generation, attachment, sha256);
        await deps.uploadAsset(upload, bytes);
        deps.onProgress?.(index + 1, attachments.length);
    }
    return deps.publishDraft(draft.generation, snapshot);
}
