import type { AttachmentPreview } from './attachmentTypes';
import type { StagingSnapshot } from './messageStagingQueue';

// Native picker URIs already refer to local files. Web supplies the IndexedDB
// implementation; do not import browser storage into the native runtime.
export async function persistStagedAttachments(_namespace: string, attachments: AttachmentPreview[]): Promise<AttachmentPreview[]> {
    return attachments;
}

export async function restoreStagedAttachments(_namespace: string, snapshot: StagingSnapshot) {
    return { snapshot, availableBlobUris: new Set<string>() };
}

export async function deleteStagedAttachments(_namespace: string, _attachments: AttachmentPreview[]): Promise<void> {}
export async function clearStagedAttachments(_namespaces: string[]): Promise<void> {}
