import type { Message } from './typesMessage';
import type { PublicSessionCover, PublicSessionSnapshotV2, PublicSessionThemePack } from '@slopus/happy-wire';
import { buildPublicSessionSnapshot } from './publicSessionSnapshot';
import type { PublicSessionAttachmentJob } from './publicSessionShareTypes';
import type { PreparedPublicSessionShareAsset } from './apiPublicSessionShares';
import type { PublicSessionCoverSelection } from './publicSessionShareQueue';
import { createReducer, reducer } from './reducer/reducer';
import type { NormalizedMessage } from './typesRaw';

type MessagePageState = { messages: Message[]; hasMoreOlder: boolean } | undefined;

export type PublicSessionSequencePage = {
    messages: Array<{ seq: number; normalized: NormalizedMessage | null }>;
    hasMore: boolean;
};

export async function loadSessionMessagesThroughSequence(cutoffSeq: number, deps: {
    loadPage: (beforeSeq: number) => Promise<PublicSessionSequencePage>;
}): Promise<Message[]> {
    const sequenced = new Map<number, NormalizedMessage>();
    let beforeSeq = cutoffSeq + 1;
    for (let pageIndex = 0; pageIndex < 10_000; pageIndex += 1) {
        const page = await deps.loadPage(beforeSeq);
        let nextBeforeSeq = beforeSeq;
        for (const item of page.messages) {
            if (!Number.isInteger(item.seq) || item.seq < 1 || item.seq > cutoffSeq || item.seq >= beforeSeq) continue;
            nextBeforeSeq = Math.min(nextBeforeSeq, item.seq);
            if (item.normalized) sequenced.set(item.seq, item.normalized);
        }
        if (!page.hasMore) break;
        if (nextBeforeSeq >= beforeSeq) throw new Error('Session history pagination stalled');
        beforeSeq = nextBeforeSeq;
        if (pageIndex === 9_999) throw new Error('Session history exceeds the supported page count');
    }

    const state = createReducer();
    const normalized = Array.from(sequenced.entries())
        .sort(([left], [right]) => left - right)
        .map(([, message]) => message);
    const reduced = reducer(state, normalized);
    const messages = new Map<string, Message>();
    for (const message of reduced.messages) messages.set(message.id, message);
    return Array.from(messages.values()).sort((left, right) => right.createdAt - left.createdAt);
}

export async function loadCompleteSessionMessages(sessionId: string, deps: {
    ensureMessagesLoaded: (sessionId: string) => Promise<void>;
    loadOlderMessages: (sessionId: string) => Promise<void>;
    getMessageState: () => MessagePageState;
}): Promise<Message[]> {
    await deps.ensureMessagesLoaded(sessionId);
    for (let page = 0; page < 10_000; page += 1) {
        const state = deps.getMessageState();
        if (!state?.hasMoreOlder) return state?.messages ?? [];
        const oldestId = state.messages[0]?.id ?? null;
        await deps.loadOlderMessages(sessionId);
        const nextState = deps.getMessageState();
        if (nextState?.hasMoreOlder && nextState.messages[0]?.id === oldestId) {
            // Background prefetch and the share flow can ask for the same page.
            // loadOlderMessages intentionally returns while another request owns
            // that page, so wait briefly and retry instead of treating it as a
            // permanently stalled history load.
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error('Session history exceeds the supported page count');
}

export type PublicSessionPublishDependencies = {
    loadMessages: () => Promise<Message[]>;
    createDraft: () => Promise<{ generation: string; publicId: string }>;
    loadAttachmentBytes: (asset: PublicSessionAttachmentJob) => Promise<Uint8Array>;
    loadCoverBytes?: (selection: Extract<PublicSessionCoverSelection, { kind: 'upload' }>) => Promise<Uint8Array>;
    prepareAsset: (generation: string, asset: PublicSessionAttachmentJob, sha256: string) => Promise<PreparedPublicSessionShareAsset>;
    uploadAsset: (upload: PreparedPublicSessionShareAsset, bytes: Uint8Array) => Promise<void>;
    importPexelsCover?: (generation: string, assetId: string, photoId: number) => Promise<PublicSessionCover>;
    cloneExistingCover?: (generation: string, assetId: string) => Promise<PublicSessionCover>;
    publishDraft: (generation: string, snapshot: PublicSessionSnapshotV2) => Promise<{ publicId: string; publishedAt: number }>;
    cleanupPublishedShare?: () => Promise<void>;
    createAttachmentId?: () => string;
    hashAttachmentBytes?: (bytes: Uint8Array) => Promise<string>;
    onProgress?: (completed: number, total: number) => void;
    isCancelled?: () => boolean;
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const Crypto = await import('expo-crypto');
    const digestInput = new Uint8Array(bytes.length);
    digestInput.set(bytes);
    const digest = new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, digestInput));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function replaceAttachmentSize(snapshot: PublicSessionSnapshotV2, attachmentId: string, size: number): void {
    for (const message of snapshot.messages) {
        for (const block of message.blocks) {
            if (block.type === 'attachment' && block.attachmentId === attachmentId) block.size = size;
        }
    }
}

export async function publishPublicSessionSnapshot(
    input: {
        sessionId: string;
        jobId?: string;
        title: string;
        sharedAt: number;
        themePack?: PublicSessionThemePack;
        coverSelection?: PublicSessionCoverSelection;
        groupToolCalls?: boolean;
    },
    deps: PublicSessionPublishDependencies,
): Promise<{ publicId: string; publishedAt: number }> {
    if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
    const messages = await deps.loadMessages();
    if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
    const { snapshot, attachments } = buildPublicSessionSnapshot({
        title: input.title,
        messages,
        sharedAt: input.sharedAt,
        themePack: input.themePack ?? 'caramel',
        groupToolCalls: input.groupToolCalls,
        createAttachmentId: deps.createAttachmentId,
    });
    const draft = await deps.createDraft();
    if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
    const total = attachments.length + (input.coverSelection ? 1 : 0);
    let completed = 0;
    deps.onProgress?.(completed, total);

    if (input.coverSelection?.kind === 'existing') {
        if (!deps.cloneExistingCover) throw new Error('Public session existing cover clone is unavailable');
        snapshot.appearance.cover = await deps.cloneExistingCover(
            draft.generation,
            input.coverSelection.assetId,
        );
        if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
        completed += 1;
        deps.onProgress?.(completed, total);
    } else if (input.coverSelection?.kind === 'pexels') {
        if (!input.jobId) throw new Error('Public session share job ID is unavailable');
        if (!deps.importPexelsCover) throw new Error('Public session Pexels cover import is unavailable');
        snapshot.appearance.cover = await deps.importPexelsCover(
            draft.generation,
            input.jobId,
            input.coverSelection.photoId,
        );
        if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
        completed += 1;
        deps.onProgress?.(completed, total);
    } else if (input.coverSelection?.kind === 'upload') {
        if (!deps.loadCoverBytes) throw new Error('Public session cover bytes are unavailable');
        const selection = input.coverSelection;
        const bytes = await deps.loadCoverBytes(selection);
        if (bytes.length === 0) throw new Error('Public session cover is empty');
        const asset: PublicSessionAttachmentJob = {
            attachmentId: selection.attachmentId,
            sourceRef: selection.uri,
            encrypted: false,
            kind: 'image',
            name: selection.name,
            mimeType: selection.mimeType,
            size: bytes.length,
        };
        const sha256 = await (deps.hashAttachmentBytes ?? sha256Hex)(bytes);
        const upload = await deps.prepareAsset(draft.generation, asset, sha256);
        await deps.uploadAsset(upload, bytes);
        if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
        snapshot.appearance.cover = {
            assetId: selection.attachmentId,
            mimeType: selection.mimeType,
            size: bytes.length,
            width: selection.width,
            height: selection.height,
            ...(selection.thumbhash ? { thumbhash: selection.thumbhash } : {}),
        };
        completed += 1;
        deps.onProgress?.(completed, total);
    }

    for (let index = 0; index < attachments.length; index += 1) {
        if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
        const attachment = attachments[index];
        const bytes = await deps.loadAttachmentBytes(attachment);
        if (attachment.size !== bytes.length) {
            attachment.size = bytes.length;
            replaceAttachmentSize(snapshot, attachment.attachmentId, bytes.length);
        }
        const sha256 = await (deps.hashAttachmentBytes ?? sha256Hex)(bytes);
        const upload = await deps.prepareAsset(draft.generation, attachment, sha256);
        await deps.uploadAsset(upload, bytes);
        if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
        completed += 1;
        deps.onProgress?.(completed, total);
    }
    if (deps.isCancelled?.()) throw new Error('Public session share cancelled');
    const result = await deps.publishDraft(draft.generation, snapshot);
    if (deps.isCancelled?.()) {
        await deps.cleanupPublishedShare?.();
        throw new Error('Public session share cancelled');
    }
    return result;
}
