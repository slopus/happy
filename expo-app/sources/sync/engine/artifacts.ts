import type { Encryption } from '../encryption/encryption';
import { ArtifactEncryption } from '../encryption/artifactEncryption';
import type { Artifact, DecryptedArtifact } from '../artifactTypes';

export async function decryptArtifactListItem(params: {
    artifact: Artifact;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    try {
        // Decrypt the data encryption key
        const decryptedKey = await encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
        if (!decryptedKey) {
            console.error(`Failed to decrypt key for artifact ${artifact.id}`);
            return null;
        }

        // Store the decrypted key in memory
        artifactDataKeys.set(artifact.id, decryptedKey);

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header
        const header = await artifactEncryption.decryptHeader(artifact.header);

        return {
            id: artifact.id,
            title: header?.title || null,
            sessions: header?.sessions,
            draft: header?.draft,
            body: undefined, // Body not loaded in list
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: !!header,
        };
    } catch (err) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, err);
        // Add with decryption failed flag (body is not loaded for list items)
        return {
            id: artifact.id,
            title: null,
            body: undefined,
            headerVersion: artifact.headerVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: false,
        };
    }
}

export async function decryptArtifactWithBody(params: {
    artifact: Artifact;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
}): Promise<DecryptedArtifact | null> {
    const { artifact, encryption, artifactDataKeys } = params;

    try {
        // Decrypt the data encryption key
        const decryptedKey = await encryption.decryptEncryptionKey(artifact.dataEncryptionKey);
        if (!decryptedKey) {
            console.error(`Failed to decrypt key for artifact ${artifact.id}`);
            return null;
        }

        // Store the decrypted key in memory
        artifactDataKeys.set(artifact.id, decryptedKey);

        // Create artifact encryption instance
        const artifactEncryption = new ArtifactEncryption(decryptedKey);

        // Decrypt header and body
        const header = await artifactEncryption.decryptHeader(artifact.header);
        const body = artifact.body ? await artifactEncryption.decryptBody(artifact.body) : null;

        return {
            id: artifact.id,
            title: header?.title || null,
            sessions: header?.sessions,
            draft: header?.draft,
            body: body?.body || null,
            headerVersion: artifact.headerVersion,
            bodyVersion: artifact.bodyVersion,
            seq: artifact.seq,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            isDecrypted: !!header,
        };
    } catch (error) {
        console.error(`Failed to decrypt artifact ${artifact.id}:`, error);
        return null;
    }
}

export async function decryptSocketNewArtifactUpdate(params: {
    artifactId: string;
    dataEncryptionKey: string;
    header: string;
    headerVersion: number;
    body?: string | null;
    bodyVersion?: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    encryption: Encryption;
    artifactDataKeys: Map<string, Uint8Array>;
}): Promise<DecryptedArtifact | null> {
    const {
        artifactId,
        dataEncryptionKey,
        header,
        headerVersion,
        body,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        encryption,
        artifactDataKeys,
    } = params;

    // Decrypt the data encryption key
    const decryptedKey = await encryption.decryptEncryptionKey(dataEncryptionKey);
    if (!decryptedKey) {
        console.error(`Failed to decrypt key for new artifact ${artifactId}`);
        return null;
    }

    // Store the decrypted key in memory
    artifactDataKeys.set(artifactId, decryptedKey);

    // Create artifact encryption instance
    const artifactEncryption = new ArtifactEncryption(decryptedKey);

    // Decrypt header
    const decryptedHeader = await artifactEncryption.decryptHeader(header);

    // Decrypt body if provided
    let decryptedBody: string | null | undefined = undefined;
    if (body && bodyVersion !== undefined) {
        const decrypted = await artifactEncryption.decryptBody(body);
        decryptedBody = decrypted?.body || null;
    }

    return {
        id: artifactId,
        title: decryptedHeader?.title || null,
        body: decryptedBody,
        headerVersion,
        bodyVersion,
        seq,
        createdAt,
        updatedAt,
        isDecrypted: !!decryptedHeader,
    };
}

export async function applySocketArtifactUpdate(params: {
    existingArtifact: DecryptedArtifact;
    seq: number;
    createdAt: number;
    dataEncryptionKey: Uint8Array;
    header?: { version: number; value: string } | null;
    body?: { version: number; value: string } | null;
}): Promise<DecryptedArtifact> {
    const { existingArtifact, seq, createdAt, dataEncryptionKey, header, body } = params;

    const artifactEncryption = new ArtifactEncryption(dataEncryptionKey);

    // Update artifact with new data
    const updatedArtifact: DecryptedArtifact = {
        ...existingArtifact,
        seq,
        updatedAt: createdAt,
    };

    // Decrypt and update header if provided
    if (header) {
        const decryptedHeader = await artifactEncryption.decryptHeader(header.value);
        updatedArtifact.title = decryptedHeader?.title || null;
        updatedArtifact.sessions = decryptedHeader?.sessions;
        updatedArtifact.draft = decryptedHeader?.draft;
        updatedArtifact.headerVersion = header.version;
    }

    // Decrypt and update body if provided
    if (body) {
        const decryptedBody = await artifactEncryption.decryptBody(body.value);
        updatedArtifact.body = decryptedBody?.body || null;
        updatedArtifact.bodyVersion = body.version;
    }

    return updatedArtifact;
}

export function handleDeleteArtifactSocketUpdate(params: {
    artifactId: string;
    deleteArtifact: (artifactId: string) => void;
    artifactDataKeys: Map<string, Uint8Array>;
}): void {
    const { artifactId, deleteArtifact, artifactDataKeys } = params;

    // Remove from storage
    deleteArtifact(artifactId);

    // Remove encryption key from memory
    artifactDataKeys.delete(artifactId);
}
