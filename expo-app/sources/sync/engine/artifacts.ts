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

