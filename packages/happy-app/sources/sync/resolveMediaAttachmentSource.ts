import { decryptBlob } from '@/encryption/blob';
import { sync } from './sync';
import {
    downloadEncryptedAttachment,
    requestAttachmentDownloadSource,
} from './apiAttachments';
import {
    createMediaPlaybackSource,
    downloadMediaPlaybackSource,
} from './createMediaPlaybackSource';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';

export type ResolveMediaAttachmentSourceInput = {
    sessionId: string;
    ref: string;
    mimeType: string;
    fileName?: string;
    encrypted?: boolean;
};

/** Resolve plaintext Agent output or decrypt user media only after the card opens. */
export async function resolveMediaAttachmentSource(
    input: ResolveMediaAttachmentSourceInput,
): Promise<MediaPlaybackSource> {
    const credentials = sync.getCredentials();
    if (!credentials) throw new Error('Attachment credentials are unavailable');

    if (input.encrypted === false) {
        const source = await requestAttachmentDownloadSource(credentials, input.sessionId, input.ref);
        return input.fileName
            ? downloadMediaPlaybackSource(source, input.mimeType, input.fileName)
            : downloadMediaPlaybackSource(source, input.mimeType);
    }

    const blobKey = sync.encryption.getSessionBlobKey(input.sessionId);
    if (!blobKey || blobKey.length !== 32) {
        throw new Error('Attachment key is unavailable');
    }
    const encrypted = await downloadEncryptedAttachment(credentials, input.sessionId, input.ref);
    const decrypted = decryptBlob(encrypted, blobKey);
    if (!decrypted) throw new Error('Attachment decryption failed');
    return input.fileName
        ? createMediaPlaybackSource(decrypted, input.mimeType, input.fileName)
        : createMediaPlaybackSource(decrypted, input.mimeType);
}
