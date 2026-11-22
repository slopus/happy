import { GoalProjectConversationCatalogPageSchema, type GoalProjectConversationCandidate } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { projectGoalRequest } from './projectGoals';
import { sync } from './sync';

type Candidates = { candidates: GoalProjectConversationCandidate[]; catalogFingerprint: string; catalogSnapshotId: string };
type CatalogCache = {
    account: ReturnType<typeof getRuntimeAccountSelection>;
    encryption: typeof sync.encryption;
    machineId: string;
    projectPath: string;
    expiresAt: number;
    complete: boolean;
    pending: Promise<Candidates>;
};
let catalogs: CatalogCache[] = [];
let readVersion = 0;
const encoder = new TextEncoder();

/** The daemon pins a complete encrypted directory. The Web decrypts detached
 * metadata locally, returning only selected-machine scope candidates. Root
 * keys, wrapped keys and other machines' plaintext never leave this client. */
export function loadProjectConversationCandidates(
    machineId: string,
    projectPath: string,
    options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Candidates> {
    assertAccountRuntime();
    const signal = options.signal;
    const cancellation = () => signal?.reason === undefined
        ? new DOMException('Project history read cancelled', 'AbortError') : signal.reason;
    if (signal?.aborted) return Promise.reject(cancellation());
    const account = getRuntimeAccountSelection(), encryption = sync.encryption;
    const current = () => {
        if (signal?.aborted) throw cancellation();
        assertAccountRuntime();
        if (getRuntimeAccountSelection() !== account || sync.encryption !== encryption) throw new Error('Project history account changed');
    };
    catalogs = catalogs.filter(entry => entry.account === account && entry.encryption === encryption && entry.expiresAt > Date.now() + 5_000);
    const existing = catalogs.find(entry => entry.machineId === machineId && entry.projectPath === projectPath);
    if (existing && !options.refresh && (!signal || existing.complete)) {
        return signal ? existing.pending.then(result => { current(); return result; }) : existing.pending;
    }
    catalogs = catalogs.filter(entry => entry !== existing);
    const entry: CatalogCache = { account, encryption, machineId, projectPath, expiresAt: Infinity, complete: false, pending: undefined! };
    catalogs.push(entry);
    if (catalogs.length > 2) catalogs.shift();
    const evict = () => { catalogs = catalogs.filter(candidate => candidate !== entry); };
    let detach = () => {};
    const cancelled = signal ? new Promise<never>((_resolve, reject) => {
        const abort = () => { evict(); detach(); reject(cancellation()); };
        detach = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
    }) : undefined;
    // A cancelled RPC may remain pending in the transport's shared-read map.
    // Each cancellable traversal owns a distinct request identity for its pages.
    const version = signal ? `project-conversation-catalog-${++readVersion}` : undefined;
    const read = (async () => {
        if (!encryption) throw new Error('Project history encryption is unavailable');
        const candidates: GoalProjectConversationCandidate[] = [], versions = new Map<string, number>(), cursors = new Set<string>();
        let snapshot: { snapshotId: string; catalogFingerprint: string; total: number; expiresAt: number } | undefined;
        let cursor: string | undefined, catalogBytes = 0, candidateBytes = 2;
        do {
            current();
            const input = {
                projectPath, ...(snapshot ? { snapshotId: snapshot.snapshotId, cursor } : {}),
            };
            const response = await (version
                ? projectGoalRequest(machineId, 'goalProjectConversationCatalog', input, version)
                : projectGoalRequest(machineId, 'goalProjectConversationCatalog', input));
            current();
            if (encoder.encode(JSON.stringify(response)).byteLength > 256 * 1024) throw new Error('Project history catalog page exceeds the size limit');
            const page = GoalProjectConversationCatalogPageSchema.parse(response);
            if (page.projectPath !== projectPath) throw new Error('Project history catalog scope changed');
            if (!snapshot) snapshot = page;
            else if (page.snapshotId !== snapshot.snapshotId || page.catalogFingerprint !== snapshot.catalogFingerprint
                || page.total !== snapshot.total || page.expiresAt !== snapshot.expiresAt) throw new Error('Project history catalog changed between pages');
            if (page.expiresAt <= Date.now()) throw new Error('Project history catalog expired; refresh conversations');
            for (let index = 0; index < page.sessions.length; index++) {
                current();
                const row = page.sessions[index];
                if (versions.has(row.id)) throw new Error('Project history catalog contains duplicate identities');
                versions.set(row.id, row.metadataVersion);
                if (versions.size > 20_000 || versions.size > page.total) throw new Error('Project history catalog total is invalid');
                catalogBytes += encoder.encode(JSON.stringify(row)).byteLength;
                if (catalogBytes > 64 * 1024 * 1024) throw new Error('Project history catalog exceeds the size limit');
                const key = row.dataEncryptionKey ? await encryption.decryptEncryptionKey(row.dataEncryptionKey) : null;
                current();
                if (row.dataEncryptionKey && !key) throw new Error('Project history record key could not be decrypted');
                const prepared = await encryption.prepareSessionEncryption(row.id, key);
                current();
                const metadata = await prepared.sessionEncryption.decryptMetadata(row.metadataVersion, row.metadata);
                current();
                if (!metadata) throw new Error('Project history metadata could not be decrypted');
                if (metadata.machineId === machineId) {
                    if (typeof metadata.path !== 'string' || !metadata.path) throw new Error('Project history metadata has no directory');
                    const candidate: GoalProjectConversationCandidate = {
                        sessionId: row.id, metadataVersion: row.metadataVersion, directory: metadata.path,
                        title: (metadata.name || metadata.summary?.text || '').slice(0, 2048),
                        ...(metadata.goalBoard?.featurePath ? { featurePath: metadata.goalBoard.featurePath } : {}),
                        ...(metadata.goalBoard?.taskId ? { taskId: metadata.goalBoard.taskId } : {}),
                        ...(metadata.lifecycleState ? { lifecycleState: metadata.lifecycleState } : {}),
                    };
                    candidateBytes += encoder.encode(JSON.stringify(candidate)).byteLength + 1;
                    if (candidateBytes > 512 * 1024) throw new Error('Complete project history exceeds the request size limit');
                    candidates.push(candidate);
                }
                // Finite local decryption yields input time, without querying status.
                if (index % 32 === 31) await new Promise<void>(resolve => setTimeout(resolve, 0));
            }
            current();
            if (!page.hasNext) {
                if (page.nextCursor || versions.size !== page.total) throw new Error('Project history catalog is incomplete');
                break;
            }
            if (!page.sessions.length || !page.nextCursor || page.nextCursor === cursor || cursors.has(page.nextCursor))
                throw new Error('Project history catalog cursor did not advance');
            cursors.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        const input = JSON.stringify([...versions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        const hash = await crypto.subtle.digest('SHA-256', encoder.encode(input));
        current();
        const fingerprint = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (!snapshot || fingerprint !== snapshot.catalogFingerprint) throw new Error('Project history catalog fingerprint is invalid');
        entry.expiresAt = snapshot.expiresAt;
        return { candidates, catalogFingerprint: fingerprint, catalogSnapshotId: snapshot.snapshotId };
    })();
    entry.pending = (cancelled ? Promise.race([read, cancelled]) : read).then(result => {
        current();
        entry.complete = true;
        return result;
    }).catch(error => {
        evict();
        throw error;
    }).finally(() => { detach(); });
    return entry.pending;
}
