import { detectHonorMotionPhoto } from '@slopus/happy-wire';
import { decryptBlob } from '@/encryption/blob';
import { downloadEncryptedAttachment } from './apiAttachments';
import { createMediaPlaybackSource } from './createMediaPlaybackSource';
import type { MediaPlaybackSource } from './mediaPlaybackSourceTypes';
import { sync } from './sync';

/** Download an encrypted dynamic JPEG and stage only its embedded MP4 for playback. */
export async function resolveMotionPhotoAttachmentSource(input: {
    sessionId: string;
    ref: string;
    fileName: string;
}): Promise<MediaPlaybackSource> {
    const credentials = sync.getCredentials();
    if (!credentials) throw new Error('Attachment credentials are unavailable');
    const blobKey = sync.encryption.getSessionBlobKey(input.sessionId);
    if (!blobKey || blobKey.length !== 32) throw new Error('Attachment key is unavailable');

    const encrypted = await downloadEncryptedAttachment(credentials, input.sessionId, input.ref);
    const decrypted = decryptBlob(encrypted, blobKey);
    if (!decrypted) throw new Error('Attachment decryption failed');
    const motionPhoto = detectHonorMotionPhoto(decrypted);
    if (!motionPhoto) throw new Error('Motion photo data is unavailable');

    const video = decrypted.slice(
        motionPhoto.videoOffset,
        motionPhoto.videoOffset + motionPhoto.videoLength,
    );
    return createMediaPlaybackSource(video, motionPhoto.mimeType, `${input.fileName}.mp4`);
}
