import type { AuthCredentials } from '@/auth/tokenStorage';
import type { AttachmentPreview, UploadedAttachment } from './attachmentTypes';
import type { RequestUploadResult } from './apiAttachments';
import { MAX_PDF_FILE_SIZE } from './attachmentLimits';

export type AttachmentUploadDependencies = {
    requestUpload: (
        credentials: AuthCredentials,
        sessionId: string,
        filename: string,
        size: number,
        kind?: 'image' | 'audio' | 'video' | 'file',
    ) => Promise<RequestUploadResult>;
    uploadMediaFile: (
        upload: RequestUploadResult,
        fileUri: string,
        mimeType: string,
        credentials: AuthCredentials,
    ) => Promise<void>;
    readFileBytes: (uri: string, maxBytes?: number) => Promise<Uint8Array>;
    encryptBlob: (bytes: Uint8Array, blobKey: Uint8Array) => Uint8Array;
    uploadEncryptedBlob: (
        upload: RequestUploadResult,
        encryptedData: Uint8Array,
        credentials: AuthCredentials,
    ) => Promise<void>;
};

/** Upload one attachment using the lane appropriate for its media kind. */
export async function uploadAttachmentForSession(
    input: {
        credentials: AuthCredentials;
        sessionId: string;
        attachment: AttachmentPreview;
        blobKey?: Uint8Array;
    },
    dependencies: AttachmentUploadDependencies,
): Promise<UploadedAttachment> {
    const { credentials, sessionId, attachment, blobKey } = input;
    const kind = attachment.kind ?? 'image';
    const isMedia = kind === 'audio' || kind === 'video';

    if (isMedia) {
        const upload = await dependencies.requestUpload(
            credentials,
            sessionId,
            attachment.name,
            attachment.size,
            kind,
        );
        await dependencies.uploadMediaFile(upload, attachment.uri, attachment.mimeType, credentials);
        return {
            ref: upload.ref,
            name: attachment.name,
            size: attachment.size,
            width: 0,
            height: 0,
            kind,
            mimeType: attachment.mimeType,
            encrypted: false,
        };
    }

    if (!blobKey) {
        throw new Error(`Attachment encryption key is unavailable for ${attachment.name}`);
    }
    const bytes = await dependencies.readFileBytes(
        attachment.uri,
        kind === 'file' ? MAX_PDF_FILE_SIZE : undefined,
    );
    if (kind === 'file' && bytes.length > MAX_PDF_FILE_SIZE) {
        throw new Error('PDF attachment is too large');
    }
    const encrypted = dependencies.encryptBlob(bytes, blobKey);
    const upload = await dependencies.requestUpload(
        credentials,
        sessionId,
        attachment.name,
        encrypted.length,
    );
    await dependencies.uploadEncryptedBlob(upload, encrypted, credentials);
    return {
        ref: upload.ref,
        name: attachment.name,
        size: attachment.size,
        width: attachment.width,
        height: attachment.height,
        thumbhash: attachment.thumbhash,
        ...(kind === 'file' ? { kind, mimeType: attachment.mimeType } : {}),
    };
}
