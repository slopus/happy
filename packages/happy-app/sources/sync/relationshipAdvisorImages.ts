import { TokenStorage } from '@/auth/tokenStorage';
import { readFileBytes } from '@/utils/readFileBytes';
import type { AttachmentPreview } from './attachmentTypes';
import { uploadEncryptedBlob, type RequestUploadResult } from './apiAttachments';
import { apiSocket } from './apiSocket';

export const MAX_RELATIONSHIP_ADVISOR_IMAGE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface RelationshipAdvisorImageBatchDependencies {
    upload: typeof uploadRelationshipAdvisorImage;
    discard: typeof discardRelationshipAdvisorImages;
}

export async function discardRelationshipAdvisorImages(refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    const response = await apiSocket.request('/v1/relationship-advisor/images', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refs }),
    });
    if (!response.ok) {
        throw new Error(`Relationship advisor image cleanup failed: ${response.status}`);
    }
}

export async function uploadRelationshipAdvisorImage(image: AttachmentPreview): Promise<string> {
    if ((image.kind && image.kind !== 'image') || !SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
        throw new Error('Unsupported relationship advisor image');
    }

    const bytes = await readFileBytes(image.uri, MAX_RELATIONSHIP_ADVISOR_IMAGE_SIZE);
    const response = await apiSocket.request('/v1/relationship-advisor/images/request-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mimeType: image.mimeType, size: bytes.length }),
    });
    if (!response.ok) {
        throw new Error(`Relationship advisor image upload request failed: ${response.status}`);
    }

    const upload = await response.json() as RequestUploadResult;
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error('Authentication credentials are unavailable');

    // The helper handles presigned POST and authenticated local PUT transports.
    // These bytes are intentionally plaintext; no session key exists in this lane.
    await uploadEncryptedBlob(upload, bytes, credentials);
    return upload.ref;
}

export async function uploadRelationshipAdvisorImages(
    images: AttachmentPreview[],
    options: { isCancelled: () => boolean },
    dependencies: RelationshipAdvisorImageBatchDependencies = {
        upload: uploadRelationshipAdvisorImage,
        discard: discardRelationshipAdvisorImages,
    },
): Promise<string[] | null> {
    const refs: string[] = [];
    try {
        for (const image of images) {
            if (options.isCancelled()) {
                await dependencies.discard(refs);
                return null;
            }
            refs.push(await dependencies.upload(image));
            if (options.isCancelled()) {
                await dependencies.discard(refs);
                return null;
            }
        }
        return refs;
    } catch (error) {
        await dependencies.discard(refs).catch(() => undefined);
        throw error;
    }
}
