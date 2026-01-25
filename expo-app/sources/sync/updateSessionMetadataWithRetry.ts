export type UpdateMetadataAck = {
    result: 'success' | 'version-mismatch' | 'error';
    version?: number;
    metadata?: string;
    message?: string;
};

export type SessionMetadataSnapshot<M> = {
    metadataVersion: number;
    metadata: M;
};

/**
 * Best-effort helper for updating encrypted session metadata over the websocket `update-metadata` RPC.
 *
 * The server does not merge metadata (it is encrypted), so we must:
 * - fetch the latest version on version-mismatch
 * - re-apply our updater and retry
 *
 * This is used for high-frequency metadata writers (message queue, read markers), so it must be resilient
 * to repeated version-mismatches during concurrent updates.
 */
export async function updateSessionMetadataWithRetry<M>(params: {
    sessionId: string;
    getSession: () => SessionMetadataSnapshot<M> | null;
    refreshSessions: () => Promise<void>;
    encryptMetadata: (metadata: M) => Promise<string>;
    decryptMetadata: (version: number, encrypted: string) => Promise<M | null>;
    emitUpdateMetadata: (payload: { sid: string; expectedVersion: number; metadata: string }) => Promise<UpdateMetadataAck>;
    applySessionMetadata: (next: SessionMetadataSnapshot<M>) => void;
    updater: (base: M) => M;
    maxAttempts?: number;
}): Promise<void> {
    const {
        sessionId,
        getSession,
        refreshSessions,
        encryptMetadata,
        decryptMetadata,
        emitUpdateMetadata,
        applySessionMetadata,
        updater,
        maxAttempts = 6,
    } = params;

    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
        const current = getSession();
        if (!current) {
            throw new Error('Session metadata not available');
        }

        const expectedVersion = current.metadataVersion;
        const updatedMetadata = updater(current.metadata);
        const encryptedMetadata = await encryptMetadata(updatedMetadata);

        const result = await emitUpdateMetadata({
            sid: sessionId,
            expectedVersion,
            metadata: encryptedMetadata,
        });

        if (result.result === 'success') {
            if (typeof result.version === 'number' && typeof result.metadata === 'string') {
                const decrypted = await decryptMetadata(result.version, result.metadata);
                if (decrypted) {
                    applySessionMetadata({ metadataVersion: result.version, metadata: decrypted });
                }
            }
            return;
        }

        if (result.result === 'version-mismatch') {
            // Prefer the server-provided current version+metadata; it avoids a whole refresh round-trip.
            if (typeof result.version === 'number' && typeof result.metadata === 'string') {
                const decrypted = await decryptMetadata(result.version, result.metadata);
                if (decrypted) {
                    applySessionMetadata({ metadataVersion: result.version, metadata: decrypted });
                } else {
                    await refreshSessions();
                }
            } else {
                await refreshSessions();
            }

            // Short backoff to reduce tight-loop retries during concurrent writers.
            if (attemptIndex < maxAttempts - 1) {
                await new Promise((r) => setTimeout(r, Math.min(50 * (attemptIndex + 1), 250)));
            }
            continue;
        }

        throw new Error(result.message || 'Failed to update session metadata');
    }

    throw new Error(`Failed to update session metadata after ${maxAttempts} attempts`);
}

