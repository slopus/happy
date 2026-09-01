import { v4 as uuid } from 'uuid';
import { decryptBlob } from '@/encryption/blob';
import { t } from '@/text';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { sync } from './sync';
import { apiSocket } from './apiSocket';
import type { ApiMessage } from './apiTypes';
import { normalizeRawMessage } from './typesRaw';
import { getServerUrl } from './serverConfig';
import { downloadEncryptedAttachment, requestAttachmentDownloadSource } from './apiAttachments';
import {
    createPublicSessionShareDraft,
    preparePublicSessionShareAsset,
    publishPublicSessionShareDraft,
    revokePublicSessionShare,
    uploadPublicSessionShareAsset,
} from './apiPublicSessionShares';
import type { PublicSessionAttachmentJob } from './publicSessionShareTypes';
import { loadSessionMessagesThroughSequence, publishPublicSessionSnapshot } from './publicSessionSharePublishing';
import { createPublicSessionShareQueue, type PublicSessionShareJob } from './publicSessionShareQueue';
import { publicSessionShareQueueStorage } from './publicSessionShareQueuePersistence';
import { notifyPublicSessionShareJob } from './publicSessionShareNotifications';

async function loadAttachmentBytes(
    credentials: AuthCredentials,
    sessionId: string,
    attachment: PublicSessionAttachmentJob,
): Promise<Uint8Array> {
    if (attachment.encrypted) {
        const key = sync.encryption.getSessionBlobKey(sessionId);
        if (!key || key.length !== 32) throw new Error(t('sessionShare.attachmentKeyUnavailable'));
        const encrypted = await downloadEncryptedAttachment(credentials, sessionId, attachment.sourceRef);
        const decrypted = decryptBlob(encrypted, key);
        if (!decrypted) throw new Error(`${t('sessionShare.attachmentDownloadFailed')}: ${attachment.name}`);
        return decrypted;
    }
    const source = await requestAttachmentDownloadSource(credentials, sessionId, attachment.sourceRef);
    const response = await fetch(source.uri, { headers: source.headers });
    if (!response.ok) throw new Error(`${t('sessionShare.attachmentDownloadFailed')}: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

const queue = createPublicSessionShareQueue({
    storage: publicSessionShareQueueStorage,
    createId: uuid,
    notify: notifyPublicSessionShareJob,
    canExecute: (job) => (
        !!sync.getCredentials()
        && sync.serverID === job.ownerId
        && getServerUrl() === job.serverUrl
    ),
    execute: async (job, context) => {
        const credentials = sync.getCredentials();
        if (!credentials) throw new Error(t('sessionShare.authenticationUnavailable'));
        return publishPublicSessionSnapshot(
            {
                sessionId: job.sessionId,
                title: job.title,
                sharedAt: job.requestedAt,
                groupToolCalls: job.groupToolCalls,
            },
            {
                loadMessages: () => loadSessionMessagesThroughSequence(job.cutoffSeq, {
                    loadPage: async (beforeSeq) => {
                        const encryption = sync.encryption.getSessionEncryption(job.sessionId);
                        if (!encryption) throw new Error(t('sessionShare.attachmentKeyUnavailable'));
                        const response = await apiSocket.request(
                            `/v3/sessions/${encodeURIComponent(job.sessionId)}/messages?before_seq=${beforeSeq}&limit=100`,
                        );
                        if (!response.ok) throw new Error(`Load public session share history failed: ${response.status}`);
                        const data = await response.json() as { messages?: ApiMessage[]; hasMore?: boolean };
                        const messages = Array.isArray(data.messages) ? data.messages : [];
                        const decrypted = await encryption.decryptMessages(messages);
                        return {
                            hasMore: data.hasMore === true,
                            messages: messages.map((message, index) => {
                                const value = decrypted[index];
                                return {
                                    seq: message.seq,
                                    normalized: value
                                        ? normalizeRawMessage(value.id, value.localId, value.createdAt, value.content)
                                        : null,
                                };
                            }),
                        };
                    },
                }),
                createDraft: () => createPublicSessionShareDraft(credentials, job.sessionId),
                loadAttachmentBytes: (asset) => loadAttachmentBytes(credentials, job.sessionId, asset),
                prepareAsset: (generation, asset, sha256) => (
                    preparePublicSessionShareAsset(credentials, job.sessionId, generation, asset, sha256)
                ),
                uploadAsset: (upload, bytes) => uploadPublicSessionShareAsset(upload, bytes, credentials),
                publishDraft: (generation, snapshot) => (
                    publishPublicSessionShareDraft(credentials, job.sessionId, generation, snapshot)
                ),
                cleanupPublishedShare: () => revokePublicSessionShare(credentials, job.sessionId),
                onProgress: context.onProgress,
                isCancelled: context.isCancelled,
            },
        );
    },
});

export function enqueuePublicSessionShareJob(input: {
    sessionId: string;
    title: string;
    requestedAt: number;
    cutoffSeq: number;
    groupToolCalls: boolean;
}): PublicSessionShareJob {
    return queue.enqueue({
        ...input,
        ownerId: sync.serverID,
        serverUrl: getServerUrl(),
    });
}

export function cancelPublicSessionShareJob(sessionId: string): void {
    queue.cancel(sessionId);
}

export function clearPublicSessionShareJobs(): void {
    queue.clear();
}

export function retryPublicSessionShareJob(sessionId: string): boolean {
    return queue.retry(sessionId);
}

export function getPublicSessionShareJob(sessionId: string): PublicSessionShareJob | null {
    return queue.getJob(sessionId);
}

export function subscribePublicSessionShareJobs(listener: () => void): () => void {
    return queue.subscribe(listener);
}

export function resumePublicSessionShareJobs(): Promise<void> {
    return queue.resume();
}
