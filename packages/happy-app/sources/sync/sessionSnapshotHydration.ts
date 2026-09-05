import type { ApiSessionSnapshot } from './apiTypes';
import type { Encryption } from './encryption/encryption';
import type { Session } from './storageTypes';

export type HydratedSession = Omit<Session, 'presence'> & {
    presence?: 'online' | number;
};

export interface SessionSnapshotHydrationLogger {
    warn(message: string): void;
}

export interface SessionSnapshotHydrationGuard {
    assertCurrent(): void;
}

export interface PreparedRouteSessionHydration {
    session: HydratedSession;
    commitEncryption(): boolean;
}

const defaultLogger: SessionSnapshotHydrationLogger = {
    warn(message) {
        console.warn(message);
    },
};

/**
 * Initializes the session encryption required by each snapshot and decrypts
 * only the supplied sessions. State application deliberately stays in Sync.
 */
export async function hydrateSessionSnapshots(
    snapshots: ApiSessionSnapshot[],
    encryption: Encryption,
    logger: SessionSnapshotHydrationLogger = defaultLogger,
): Promise<HydratedSession[]> {
    const keys = new Map<string, Uint8Array | null>();
    const accepted: ApiSessionSnapshot[] = [];

    for (const snapshot of snapshots) {
        let key: Uint8Array | null = null;
        if (snapshot.dataEncryptionKey) {
            try {
                key = await encryption.decryptEncryptionKey(snapshot.dataEncryptionKey);
            } catch {
                key = null;
            }
            if (!key) {
                logger.warn('Skipping session snapshot because its data key could not be decrypted');
                continue;
            }
        }
        keys.set(snapshot.id, key);
        accepted.push(snapshot);
    }

    await encryption.initializeSessions(keys);

    return Promise.all(accepted.map(async (snapshot) => {
        const sessionEncryption = encryption.getSessionEncryption(snapshot.id);
        if (!sessionEncryption) {
            throw new Error(`Session encryption not found for ${snapshot.id}`);
        }
        const [metadata, agentState] = await Promise.all([
            sessionEncryption.decryptMetadata(snapshot.metadataVersion, snapshot.metadata),
            sessionEncryption.decryptAgentState(snapshot.agentStateVersion, snapshot.agentState),
        ]);
        return {
            ...snapshot,
            lastMessage: snapshot.lastMessage ?? null,
            metadata,
            agentState,
            thinking: false,
            thinkingAt: 0,
        };
    }));
}

export async function hydrateSessionSnapshotForRoute(
    snapshot: ApiSessionSnapshot,
    encryption: Encryption,
    guard: SessionSnapshotHydrationGuard,
    logger: SessionSnapshotHydrationLogger = defaultLogger,
): Promise<PreparedRouteSessionHydration | null> {
    guard.assertCurrent();
    let key: Uint8Array | null = null;
    if (snapshot.dataEncryptionKey) {
        try {
            key = await encryption.decryptEncryptionKey(snapshot.dataEncryptionKey);
        } catch {
            key = null;
        }
        guard.assertCurrent();
        if (!key) {
            logger.warn('Skipping session snapshot because its data key could not be decrypted');
            return null;
        }
    }

    const prepared = await encryption.prepareSessionEncryption(snapshot.id, key);
    guard.assertCurrent();
    const [metadata, agentState] = await Promise.all([
        prepared.sessionEncryption.decryptMetadata(snapshot.metadataVersion, snapshot.metadata),
        prepared.sessionEncryption.decryptAgentState(snapshot.agentStateVersion, snapshot.agentState),
    ]);
    guard.assertCurrent();

    return {
        session: {
            ...snapshot,
            metadata,
            agentState,
            thinking: false,
            thinkingAt: 0,
        },
        commitEncryption: prepared.commit,
    };
}
