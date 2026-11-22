import type { GoalProjectConversationCandidate } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { TokenStorage } from '@/auth/tokenStorage';
import { fetchSessionSnapshotPage } from './apiSessions';
import { sync } from './sync';

/** The signed-in Web client owns the account content secret. Read detached
 * metadata only; never export record/root keys or hydrate the history store. */
export async function loadProjectConversationCandidates(
    machineId: string,
): Promise<{ candidates: GoalProjectConversationCandidate[]; catalogFingerprint: string }> {
    assertAccountRuntime();
    const account = getRuntimeAccountSelection(),
        encryption = sync.encryption;
    const current = () => {
        assertAccountRuntime();
        if (getRuntimeAccountSelection() !== account || sync.encryption !== encryption) throw new Error('Project history account changed');
    };
    const credentials = await TokenStorage.getCredentials();
    current();
    if (!credentials || !encryption) throw new Error('Project history authentication is unavailable');
    const candidates = new Map<string, GoalProjectConversationCandidate>();
    const versions = new Map<string, number>();
    const cursors = new Set<string>();
    let cursor: string | undefined,
        count = 0,
        bytes = 2;
    do {
        current();
        const page = await fetchSessionSnapshotPage(credentials, { limit: 200, ...(cursor ? { cursor } : {}) });
        current();
        count += page.sessions.length;
        if (count > 20_000) throw new Error('Complete project history catalog limit reached');
        for (let index = 0; index < page.sessions.length; index++) {
            const row = page.sessions[index];
            versions.set(row.id, row.metadataVersion);
            const key = row.dataEncryptionKey ? await encryption.decryptEncryptionKey(row.dataEncryptionKey) : null;
            current();
            if (row.dataEncryptionKey && !key) throw new Error('Project history record key could not be decrypted');
            const prepared = await encryption.prepareSessionEncryption(row.id, key);
            const metadata = await prepared.sessionEncryption.decryptMetadata(row.metadataVersion, row.metadata);
            current();
            if (!metadata) throw new Error('Project history metadata could not be decrypted');
            if (metadata.machineId === machineId) {
                const candidate: GoalProjectConversationCandidate = {
                    sessionId: row.id,
                    metadataVersion: row.metadataVersion,
                    directory: metadata.path,
                    title: (metadata.name || metadata.summary?.text || '').slice(0, 2048),
                    ...(metadata.goalBoard?.featurePath ? { featurePath: metadata.goalBoard.featurePath } : {}),
                    ...(metadata.goalBoard?.taskId ? { taskId: metadata.goalBoard.taskId } : {}),
                    ...(metadata.lifecycleState ? { lifecycleState: metadata.lifecycleState } : {}),
                };
                const previous = candidates.get(row.id);
                bytes += new TextEncoder().encode(JSON.stringify(candidate)).byteLength + 1;
                if (previous) bytes -= new TextEncoder().encode(JSON.stringify(previous)).byteLength + 1;
                if (bytes > 512 * 1024) throw new Error('Complete project history exceeds the request size limit');
                candidates.set(row.id, candidate);
            }
            // Finite decryption batches yield input time; this timer never queries status.
            if (index % 32 === 31) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!page.hasNext) break;
        if (!page.nextCursor || page.nextCursor === cursor || cursors.has(page.nextCursor))
            throw new Error('Project history catalog cursor did not advance');
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
    } while (cursor);
    current();
    const input = JSON.stringify([...versions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    current();
    const catalogFingerprint = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return { candidates: [...candidates.values()], catalogFingerprint };
}
