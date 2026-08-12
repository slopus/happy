import type { AttachmentImageSourceOptions } from '@/utils/attachmentImageSourceTypes';
import type { MotionPhotoMetadata } from '@/sync/attachmentTypes';

export const ATTACHMENT_THUMBNAIL_MAX_DIMENSION = 1024;

export type AttachmentImageOptions = AttachmentImageSourceOptions & {
    /** Keep full-resolution data only for the lifetime of the fullscreen viewer. */
    lifetime?: 'shared' | 'viewer';
};

export type AttachmentImageState = {
    uri: string | null;
    loading: boolean;
    error: string | null;
    motionPhoto?: MotionPhotoMetadata;
};
