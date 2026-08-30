import * as React from 'react';
import type { AuthCredentials } from '@/auth/tokenStorage';
import { decryptBlob } from '@/encryption/blob';
import { useHappyAction } from './useHappyAction';
import { HappyError } from '@/utils/errors';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import type { PublicSessionAttachmentJob, PublicSessionShareState } from '@/sync/publicSessionShareTypes';
import { loadCompleteSessionMessages, publishPublicSessionSnapshot } from '@/sync/publicSessionSharePublishing';
import { downloadEncryptedAttachment, requestAttachmentDownloadSource } from '@/sync/apiAttachments';
import {
    createPublicSessionShareDraft,
    getPublicSessionShare,
    getPublicSessionShareUrl,
    preparePublicSessionShareAsset,
    publishPublicSessionShareDraft,
    revokePublicSessionShare,
    uploadPublicSessionShareAsset,
} from '@/sync/apiPublicSessionShares';
import { t } from '@/text';

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

export function usePublicSessionShare(sessionId: string, title: string) {
    const [shareState, setShareState] = React.useState<PublicSessionShareState>({ active: false, publicId: null, publishedAt: null });
    const [progress, setProgress] = React.useState({ completed: 0, total: 0 });
    const [checking, setChecking] = React.useState(true);

    const credentials = sync.getCredentials();
    const refresh = React.useCallback(async () => {
        if (!credentials) {
            setChecking(false);
            return;
        }
        try {
            setShareState(await getPublicSessionShare(credentials, sessionId));
        } catch {
            setShareState({ active: false, publicId: null, publishedAt: null });
        } finally {
            setChecking(false);
        }
    }, [credentials, sessionId]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const [publishing, performPublish] = useHappyAction(async () => {
        if (!credentials) throw new HappyError(t('sessionShare.authenticationUnavailable'), false);
        try {
            const result = await publishPublicSessionSnapshot(
                { sessionId, title, sharedAt: Date.now() },
                {
                    loadMessages: () => loadCompleteSessionMessages(sessionId, {
                        ensureMessagesLoaded: sync.ensureMessagesLoaded,
                        loadOlderMessages: sync.loadOlderMessages,
                        getMessageState: () => storage.getState().sessionMessages[sessionId],
                    }),
                    createDraft: () => createPublicSessionShareDraft(credentials, sessionId),
                    loadAttachmentBytes: (asset) => loadAttachmentBytes(credentials, sessionId, asset),
                    prepareAsset: (generation, asset, sha256) => preparePublicSessionShareAsset(credentials, sessionId, generation, asset, sha256),
                    uploadAsset: (upload, bytes) => uploadPublicSessionShareAsset(upload, bytes, credentials),
                    publishDraft: (generation, snapshot) => publishPublicSessionShareDraft(credentials, sessionId, generation, snapshot),
                    onProgress: (completed, total) => setProgress({ completed, total }),
                },
            );
            setShareState({ active: true, publicId: result.publicId, publishedAt: result.publishedAt });
        } catch (error) {
            throw new HappyError(error instanceof Error ? error.message : t('sessionShare.shareFailed'), false);
        }
    });

    const [revoking, performRevoke] = useHappyAction(async () => {
        if (!credentials) throw new HappyError(t('sessionShare.authenticationUnavailable'), false);
        try {
            await revokePublicSessionShare(credentials, sessionId);
            setShareState({ active: false, publicId: null, publishedAt: null });
        } catch (error) {
            throw new HappyError(error instanceof Error ? error.message : t('sessionShare.revokeFailed'), false);
        }
    });

    return {
        shareState,
        shareUrl: shareState.publicId ? getPublicSessionShareUrl(shareState.publicId) : null,
        progress,
        checking,
        publishing,
        revoking,
        refresh,
        publish: performPublish,
        revoke: performRevoke,
    };
}
