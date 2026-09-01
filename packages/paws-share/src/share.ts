import { randomBytes, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { PublicSessionSnapshot } from '@slopus/happy-wire';
import { PawsShareClient, type CreateDraftResult, type ManagedShareStatus, type UploadAsset } from './api/client';
import { claudeCodeAdapter } from './adapters/claudeCode';
import { codexAdapter } from './adapters/codex';
import type { ConvertedSnapshot, TranscriptAdapter, TranscriptCandidate } from './adapters/types';
import { readResolvedAttachmentBytes } from './adapters/shared';
import { ShareRecordStore, type ShareSource } from './records';
import { assertShareExportSafe } from './security/exportPolicy';
import { scanShareExport, type SecretFinding } from './security/secretScanner';

export type ShareApi = {
    createDraft(sourceProvider: ShareSource, requestId: string): Promise<CreateDraftResult>;
    createReplacementDraft(shareId: string): Promise<{ generation: string; publicId: string }>;
    prepareAndUploadAsset(shareId: string, generation: string, asset: UploadAsset): Promise<void>;
    publish(shareId: string, generation: string, snapshot: PublicSessionSnapshot): Promise<{ publicId: string; publishedAt: number }>;
    status(shareId: string): Promise<ManagedShareStatus>;
    renew(shareId: string): Promise<{ expiresAt: string }>;
    revoke(shareId: string): Promise<{ ok: true }>;
};

export type SessionInspection = {
    source: TranscriptCandidate['provider'];
    title: string;
    messageCount: number;
    attachmentCount: number;
    attachmentBytes: number;
    unresolvedAttachmentCount: number;
    blockingFindingCount: number;
    warningFindingCount: number;
};

export type ShareSessionResult = {
    publicUrl: string;
    publicId: string;
    expiresAt: string;
    source: TranscriptCandidate['provider'];
    messageCount: number;
    attachmentCount: number;
    attachmentBytes: number;
    recordId: string;
};

export type ShareSessionOptions = {
    candidate: TranscriptCandidate;
    serverUrl: string;
    store?: ShareRecordStore;
    allowSensitive?: boolean;
};

export type ShareSessionDependencies = {
    createApi?: (token: string, serverUrl: string) => ShareApi;
    createManagementToken?: () => string;
    createRequestId?: () => string;
    now?: () => Date;
};

export type ManagedShareStatusResult = {
    publicId: string;
    publicUrl: string;
    active: boolean;
    revoked: boolean;
    publishedAt: string | null;
    expiresAt: string | null;
    source: ShareSource;
};

export type ReplaceManagedShareOptions = {
    identifier: string;
    candidate: TranscriptCandidate;
    store?: ShareRecordStore;
    allowSensitive?: boolean;
};

function adapterFor(provider: TranscriptCandidate['provider']): TranscriptAdapter {
    return provider === 'codex' ? codexAdapter : claudeCodeAdapter;
}

function disclosure(converted: ConvertedSnapshot, findings: SecretFinding[], source: TranscriptCandidate['provider']): SessionInspection {
    return {
        source,
        title: converted.snapshot.title,
        messageCount: converted.snapshot.messages.length,
        attachmentCount: converted.attachments.length,
        attachmentBytes: converted.attachments.reduce((sum, attachment) => sum + attachment.size, 0),
        unresolvedAttachmentCount: converted.unresolvedAttachments.length,
        blockingFindingCount: findings.filter((finding) => finding.severity === 'block').length,
        warningFindingCount: findings.filter((finding) => finding.severity === 'warn').length,
    };
}

async function prepareSession(candidate: TranscriptCandidate): Promise<{
    converted: ConvertedSnapshot;
    findings: SecretFinding[];
    inspection: SessionInspection;
}> {
    let converted: ConvertedSnapshot | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await stat(candidate.path);
        try {
            converted = await adapterFor(candidate.provider).convert(candidate);
        } catch (error) {
            if (attempt === 0 && (error as Error).message.includes('Session changed while it was being read')) continue;
            throw error;
        }
        const after = await stat(candidate.path);
        if (before.size === after.size && before.mtimeMs === after.mtimeMs) break;
        converted = undefined;
    }
    if (!converted) throw new Error('Session changed while it was being converted; retry after the current turn finishes');
    const findings = await scanShareExport(converted.snapshot, converted.attachments);
    return { converted, findings, inspection: disclosure(converted, findings, candidate.provider) };
}

export async function inspectSession(options: { candidate: TranscriptCandidate }): Promise<SessionInspection> {
    return (await prepareSession(options.candidate)).inspection;
}

async function uploadAttachments(
    api: ShareApi,
    shareId: string,
    generation: string,
    converted: ConvertedSnapshot,
): Promise<void> {
    for (const attachment of converted.attachments) {
        await api.prepareAndUploadAsset(shareId, generation, {
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            kind: attachment.kind,
            size: attachment.size,
            sha256: attachment.sha256,
            bytes: await readResolvedAttachmentBytes(attachment),
        });
    }
}

export async function shareSession(
    options: ShareSessionOptions,
    dependencies: ShareSessionDependencies = {},
): Promise<ShareSessionResult> {
    const prepared = await prepareSession(options.candidate);
    assertShareExportSafe({
        findings: prepared.findings,
        unresolvedAttachments: prepared.converted.unresolvedAttachments,
    }, { allowSensitive: options.allowSensitive });

    const managementToken = (dependencies.createManagementToken ?? (() => randomBytes(32).toString('base64url')))();
    const requestId = (dependencies.createRequestId ?? randomUUID)();
    const api = (dependencies.createApi ?? ((token, serverUrl) => new PawsShareClient({ token, serverUrl })))(managementToken, options.serverUrl);
    const draft = await api.createDraft(options.candidate.provider, requestId);
    const store = options.store ?? new ShareRecordStore();
    const createdAt = (dependencies.now ?? (() => new Date()))().toISOString();
    await store.save({
        recordId: draft.publicId,
        serverUrl: options.serverUrl.replace(/\/$/, ''),
        publicId: draft.publicId,
        shareId: draft.shareId,
        managementToken,
        source: options.candidate.provider,
        title: prepared.converted.snapshot.title,
        createdAt,
        expiresAt: draft.expiresAt,
    });

    await uploadAttachments(api, draft.shareId, draft.generation, prepared.converted);
    await api.publish(draft.shareId, draft.generation, prepared.converted.snapshot);
    return {
        publicUrl: draft.publicUrl,
        publicId: draft.publicId,
        expiresAt: draft.expiresAt,
        source: options.candidate.provider,
        messageCount: prepared.inspection.messageCount,
        attachmentCount: prepared.inspection.attachmentCount,
        attachmentBytes: prepared.inspection.attachmentBytes,
        recordId: draft.publicId,
    };
}

export async function statusManagedShare(
    identifier: string,
    store = new ShareRecordStore(),
    createApi: (token: string, serverUrl: string) => ShareApi = (token, serverUrl) => new PawsShareClient({ token, serverUrl }),
): Promise<ManagedShareStatusResult> {
    const record = await store.get(identifier);
    if (!record) throw new Error('Managed share record not found');
    const status = await createApi(record.managementToken, record.serverUrl).status(record.shareId);
    return {
        publicId: record.publicId,
        publicUrl: `${record.serverUrl.replace(/\/$/, '')}/share/${encodeURIComponent(record.publicId)}`,
        active: status.active,
        revoked: status.revoked,
        publishedAt: status.publishedAt,
        expiresAt: status.expiresAt,
        source: record.source,
    };
}

export async function replaceManagedShare(
    options: ReplaceManagedShareOptions,
    dependencies: Pick<ShareSessionDependencies, 'createApi'> = {},
): Promise<ShareSessionResult> {
    const store = options.store ?? new ShareRecordStore();
    const record = await store.get(options.identifier);
    if (!record) throw new Error('Managed share record not found');
    if (record.source !== options.candidate.provider) {
        throw new Error(`Managed share source is ${record.source}; replacement source must match`);
    }
    const prepared = await prepareSession(options.candidate);
    assertShareExportSafe({
        findings: prepared.findings,
        unresolvedAttachments: prepared.converted.unresolvedAttachments,
    }, { allowSensitive: options.allowSensitive });
    const api = (dependencies.createApi ?? ((token, serverUrl) => new PawsShareClient({ token, serverUrl })))(
        record.managementToken,
        record.serverUrl,
    );
    const draft = await api.createReplacementDraft(record.shareId);
    if (draft.publicId !== record.publicId) throw new Error('Paws Share server returned a different public link for replacement');
    await uploadAttachments(api, record.shareId, draft.generation, prepared.converted);
    const published = await api.publish(record.shareId, draft.generation, prepared.converted.snapshot);
    if (published.publicId !== record.publicId) throw new Error('Paws Share server published a different public link for replacement');
    await store.save({ ...record, title: prepared.converted.snapshot.title });
    return {
        publicUrl: `${record.serverUrl.replace(/\/$/, '')}/share/${encodeURIComponent(record.publicId)}`,
        publicId: record.publicId,
        expiresAt: record.expiresAt,
        source: record.source,
        messageCount: prepared.inspection.messageCount,
        attachmentCount: prepared.inspection.attachmentCount,
        attachmentBytes: prepared.inspection.attachmentBytes,
        recordId: record.recordId,
    };
}

export async function renewManagedShare(
    identifier: string,
    store = new ShareRecordStore(),
    createApi: (token: string, serverUrl: string) => ShareApi = (token, serverUrl) => new PawsShareClient({ token, serverUrl }),
): Promise<{ publicId: string; expiresAt: string }> {
    const record = await store.get(identifier);
    if (!record) throw new Error('Managed share record not found');
    const renewed = await createApi(record.managementToken, record.serverUrl).renew(record.shareId);
    await store.save({ ...record, expiresAt: renewed.expiresAt });
    return { publicId: record.publicId, expiresAt: renewed.expiresAt };
}

export async function revokeManagedShare(
    identifier: string,
    store = new ShareRecordStore(),
    createApi: (token: string, serverUrl: string) => ShareApi = (token, serverUrl) => new PawsShareClient({ token, serverUrl }),
): Promise<{ publicId: string; revoked: true }> {
    const record = await store.get(identifier);
    if (!record) throw new Error('Managed share record not found');
    await createApi(record.managementToken, record.serverUrl).revoke(record.shareId);
    await store.remove(record.recordId);
    return { publicId: record.publicId, revoked: true };
}
