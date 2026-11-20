import type { AttachmentPreview } from '@/sync/attachmentTypes';
import type { SetStateAction } from 'react';
export type SessionAttachmentSelection = { images: AttachmentPreview[]; setImages: (update: SetStateAction<AttachmentPreview[]>) => void };
export function useSessionAttachmentDraft(_sessionId: string): SessionAttachmentSelection | undefined { return undefined; }
