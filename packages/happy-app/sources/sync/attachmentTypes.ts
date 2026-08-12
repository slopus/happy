/**
 * Shared types for image attachment upload pipeline.
 * Defined here (not in hooks/) to avoid circular dependencies:
 * hooks/ imports from sync/, so sync/ cannot import from hooks/.
 */

/**
 * Attachment lane:
 * - 'image' (default): E2E-encrypted, read into memory, sent as base64/localImage.
 * - 'file': E2E-encrypted document, decrypted and staged to a local path for
 *   the model. The picker currently accepts PDF only.
 * - 'audio' | 'video': plaintext, streamed from disk straight to OSS, no
 *   thumbnail; the terminal streams it back to disk and hands the model a path.
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

export type MotionPhotoMetadata = {
    videoOffset: number;
    videoLength: number;
    mimeType: 'video/mp4';
};

export type AttachmentPreview = {
    /** Stable unique identifier for use as React key and for removal. */
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    /** May be 0 if the system did not provide the file size. */
    size: number;
    name: string;
    thumbhash?: string;
    /** Absent → 'image' (back-compat with the existing image-only pipeline). */
    kind?: AttachmentKind;
};

/** Result of a successful attachment upload — ready to build a file event. */
export type UploadedAttachment = {
    ref: string;
    name: string;
    size: number;
    width: number;
    height: number;
    thumbhash?: string;
    kind?: AttachmentKind;
    mimeType?: string;
    /** Explicit false selects the plaintext streaming media lane. */
    encrypted?: boolean;
    motionPhoto?: MotionPhotoMetadata;
};
