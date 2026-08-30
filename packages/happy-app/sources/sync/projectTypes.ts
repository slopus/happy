import type { Session } from './storageTypes';

/** The opaque project record returned by the server. */
export interface ApiProjectRecord {
    id: string;
    externalId: string;
    metadata: string;
    metadataVersion: number;
    dataEncryptionKey: string | null;
    avatar: ApiProjectAvatar | null;
    createdAt: number;
    updatedAt: number;
    // The API also returns the account update sequence. The mobile client does
    // not need it, but retaining it makes the wire type forward compatible.
    seq?: number;
}

export interface ApiProjectAvatar {
    ref: string;
    preview: string;
    version: number;
}

/** Plaintext project metadata. The server never sees these fields. */
export interface ProjectMetadata {
    name: string;
    kind?: string | null;
}

/** Plaintext project avatar preview. The preview itself is encrypted on the wire. */
export interface ProjectAvatarPreview {
    thumbhash: string;
    mimeType: string;
}

/** Avatar materialized in memory as a private local/data URI. */
export interface ProjectAvatar {
    ref: string;
    version: number;
    mimeType: string;
    thumbhash: string;
    /** A data URI; never a server URL. */
    uri: string;
}

/** Decrypted project data retained by the UI. Project keys stay in Sync only. */
export interface Project {
    id: string;
    externalId: string;
    name: string;
    kind: string | null;
    metadataVersion: number;
    avatar: ProjectAvatar | null;
    createdAt: number;
    updatedAt: number;
}

/** Session linkage is top-level on current servers and metadata on older Rig. */
export function getSessionProjectId(session: Pick<Session, 'projectId' | 'metadata'>): string | null {
    const topLevel = session.projectId?.trim();
    if (topLevel) return topLevel;

    const metadataId = session.metadata?.project?.id?.trim();
    return metadataId || null;
}

/** Only Rig sessions are allowed to consume private project artwork. */
export function isHappyAgentSession(session: Pick<Session, 'metadata'>): boolean {
    return session.metadata?.client?.id === 'rig';
}