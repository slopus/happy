/**
 * Encrypted artifact from API
 */
export interface Artifact {
    id: string;
    header: string;  // Base64 encoded encrypted JSON { "title": string | null }
    headerVersion: number;
    body?: string;  // Base64 encoded encrypted JSON { "body": string | null } - only in full fetch
    bodyVersion?: number;  // Only in full fetch
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
    seq: number;
    createdAt: number;
    updatedAt: number;
}

/**
 * Decrypted artifact header
 */
export interface ArtifactHeader {
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
}

/**
 * Decrypted artifact body
 */
export interface ArtifactBody {
    body: string | null;
}

/**
 * Decrypted artifact for UI
 */
export interface DecryptedArtifact {
    id: string;
    title: string | null;
    sessions?: string[];  // Optional array of session IDs linked to this artifact
    draft?: boolean;      // Optional draft flag - hides artifact from visible list when true
    body?: string | null;  // Only loaded when viewing full artifact
    headerVersion: number;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    isDecrypted: boolean;  // Whether decryption was successful
}

/**
 * Request to create a new artifact
 */
export interface ArtifactCreateRequest {
    id: string;  // UUID generated client-side
    header: string;  // Base64 encoded encrypted header
    body: string;  // Base64 encoded encrypted body
    dataEncryptionKey: string;  // Base64 encoded encryption key (encrypted with user key)
}

/**
 * Request to update an existing artifact
 */
export interface ArtifactUpdateRequest {
    header?: string;  // Base64 encoded encrypted header
    expectedHeaderVersion?: number;
    body?: string;  // Base64 encoded encrypted body
    expectedBodyVersion?: number;
}

/**
 * Response from update operation
 */
export type ArtifactUpdateResponse = 
    | {
        success: true;
        headerVersion?: number;
        bodyVersion?: number;
    }
    | {
        success: false;
        error: 'version-mismatch';
        currentHeaderVersion?: number;
        currentBodyVersion?: number;
        currentHeader?: string;
        currentBody?: string;
    };