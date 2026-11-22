import { GoalProjectConversationCatalogManifestPageSchema, GoalProjectConversationCatalogPageSchema, type GoalProjectConversationCandidate } from '@slopus/happy-wire';
import { accountRuntimeCurrent, assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { projectGoalRequest } from './projectGoals';
import { apiSocket } from './apiSocket';
import { sync } from './sync';
import { readProjectConversationManifestHeaders, type ResolvedCatalogHeader, type ClassifiedCatalogHeader } from './projectConversationManifest.web';

type Candidates = { candidates: GoalProjectConversationCandidate[]; catalogFingerprint: string; catalogSnapshotId: string };
export type ProjectConversationHistoryProgress = { phase: 'catalog' | 'grouping'; processed: number; total: number };
type CatalogCache = {
    account: ReturnType<typeof getRuntimeAccountSelection>;
    encryption: typeof sync.encryption;
    machineId: string;
    projectPath: string;
    expiresAt: number;
    total: number;
    complete: boolean;
    pending: Promise<Candidates>;
    cached: boolean;
    reading: boolean;
    callers: number;
    snapshotId?: string;
    releasePending?: Promise<void>;
    ownerCurrent: () => boolean;
};
let catalogs: CatalogCache[] = [];
let readVersion = 0;
let documentRead = new AbortController();
const leases = new WeakMap<Candidates, () => void>();
const pendingReleases = new Map<CatalogCache, Promise<void>>();
const encoder = new TextEncoder();

function releaseIdle(entry: CatalogCache): Promise<void> | undefined {
    if (entry.releasePending) return entry.releasePending;
    if (entry.cached || entry.reading || entry.callers || !entry.snapshotId || !entry.ownerCurrent()) return;
    // Older daemons may not support cleanup. Bound the wait as well as the RPC,
    // so cleanup cannot indefinitely block the next catalog allocation.
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); });
    const release = Promise.resolve().then(async () => {
        if (entry.ownerCurrent()) await apiSocket.machineRPC(entry.machineId, 'goalProjectConversationCatalogRelease',
            { projectPath: entry.projectPath, snapshotId: entry.snapshotId }, { isCurrent: entry.ownerCurrent, overallTimeoutMs: 5_000 });
    }).catch(() => undefined);
    entry.releasePending = Promise.race([release, deadline]).finally(() => {
        clearTimeout(timer);
        pendingReleases.delete(entry);
    });
    pendingReleases.set(entry, entry.releasePending);
    return entry.releasePending;
}

function retire(entry: CatalogCache) {
    entry.cached = false;
    return releaseIdle(entry);
}

/** Each returned value owns one grouping lease; the wire payload stays plain data. */
export function releaseProjectConversationCandidates(value: Candidates): void {
    leases.get(value)?.();
    leases.delete(value);
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
    const entries = catalogs;
    catalogs = [];
    const previous = documentRead;
    documentRead = new AbortController();
    previous.abort(new DOMException('Project history document hidden', 'AbortError'));
    for (const entry of entries) retire(entry);
});

/** The daemon pins complete identities/versions and reuses explicit compact
 * classifications. The Web decrypts only opaque records and commits bounded
 * classification proofs; owner keys and foreign plaintext stay in this client. */
export function loadProjectConversationCandidates(
    machineId: string,
    projectPath: string,
    options: { refresh?: boolean; signal?: AbortSignal; onProgress?: (progress: ProjectConversationHistoryProgress) => void } = {},
): Promise<Candidates> {
    assertAccountRuntime();
    const signal = options.signal;
    const cancellation = () => signal?.reason === undefined
        ? new DOMException('Project history read cancelled', 'AbortError') : signal.reason;
    if (signal?.aborted) return Promise.reject(cancellation());
    const account = getRuntimeAccountSelection(), encryption = sync.encryption;
    const documentSignal = documentRead.signal;
    const current = () => {
        if (signal?.aborted) throw cancellation();
        if (documentSignal.aborted) throw documentSignal.reason;
        assertAccountRuntime();
        if (!accountRuntimeCurrent() || getRuntimeAccountSelection() !== account || sync.encryption !== encryption) throw new Error('Project history account changed');
    };
    const progress = (processed: number, total: number) => {
        current();
        options.onProgress?.({ phase: 'catalog', processed, total });
        current();
    };
    const cleanup = [...pendingReleases].filter(([entry]) => entry.account === account && entry.encryption === encryption && entry.machineId === machineId)
        .map(([, pending]) => pending);
    const remove = (entry: CatalogCache) => {
        const pending = retire(entry);
        if (pending) cleanup.push(pending);
    };
    catalogs = catalogs.filter(entry => {
        if (entry.account === account && entry.encryption === encryption && entry.expiresAt > Date.now() + 5_000) return true;
        remove(entry); return false;
    });
    const acquire = (entry: CatalogCache, cached: boolean, counted = false): Promise<Candidates> => {
        // Count before observing the pending promise: refresh may retire this
        // entry from another caller's completion/progress callback.
        if (!counted) entry.callers++;
        let returned = false;
        const release = () => {
            if (returned) return;
            returned = true;
            entry.callers--;
            void releaseIdle(entry);
        };
        const signals = [documentSignal, ...(signal ? [signal] : [])];
        let detach = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
            const abort = () => { try { current(); } catch (error) { reject(error); } };
            detach = () => { for (const value of signals) value.removeEventListener('abort', abort); };
            for (const value of signals) value.addEventListener('abort', abort, { once: true });
        });
        return Promise.race([entry.pending, cancelled]).then(result => {
            current();
            if (cached) progress(entry.total, entry.total);
            const value = { ...result };
            leases.set(value, release);
            return value;
        }).catch(error => { release(); throw error; }).finally(() => detach());
    };
    const existing = catalogs.find(entry => entry.machineId === machineId && entry.projectPath === projectPath);
    if (existing && !options.refresh && (!signal || existing.complete)) {
        return acquire(existing, true);
    }
    catalogs = catalogs.filter(entry => entry !== existing);
    if (existing) remove(existing);
    const ownerCurrent = () => accountRuntimeCurrent() && getRuntimeAccountSelection() === account && sync.encryption === encryption;
    const entry: CatalogCache = { account, encryption, machineId, projectPath, expiresAt: Infinity, total: 0, complete: false, pending: undefined!,
        cached: true, reading: true, callers: 1, ownerCurrent };
    catalogs.push(entry);
    if (catalogs.length > 2) remove(catalogs.shift()!);
    const rememberSnapshot = (response: unknown) => {
        if (!entry.snapshotId && response && typeof response === 'object') {
            const value = response as { projectPath?: unknown; snapshotId?: unknown };
            if (value.projectPath === projectPath && typeof value.snapshotId === 'string' && value.snapshotId.length > 0 && value.snapshotId.length <= 128)
                entry.snapshotId = value.snapshotId;
        }
        // A first response can arrive after cancellation. Release its token
        // without accepting metadata, publishing progress or dispatching pages.
        void releaseIdle(entry);
    };
    const evict = () => { catalogs = catalogs.filter(candidate => candidate !== entry); retire(entry); };
    let detach = () => {};
    const signals = [documentSignal, ...(signal ? [signal] : [])];
    const cancelled = new Promise<never>((_resolve, reject) => {
        const abort = () => { evict(); detach(); try { current(); } catch (error) { reject(error); } };
        detach = () => { for (const value of signals) value.removeEventListener('abort', abort); };
        for (const value of signals) value.addEventListener('abort', abort, { once: true });
    });
    // A retired RPC may remain in the transport's shared-read map, including
    // across BFCache. Only callers of this same entry share a traversal identity.
    const version = `project-conversation-catalog-${++readVersion}`;
    const read = (async () => {
        if (cleanup.length) await Promise.all(cleanup);
        current();
        if (!encryption) throw new Error('Project history encryption is unavailable');
        progress(0, 0);
        const candidates: GoalProjectConversationCandidate[] = [], versions = new Map<string, number>(), cursors = new Set<string>();
        let snapshot: { snapshotId: string; catalogFingerprint: string; total: number; expiresAt: number } | undefined;
        let cursor: string | undefined, catalogBytes = 0, candidateBytes = 2, indexSupported = false;
        const indexEntries: ClassifiedCatalogHeader[] = [];
        const append = (candidate: GoalProjectConversationCandidate) => {
            candidateBytes += encoder.encode(JSON.stringify(candidate)).byteLength + 1;
            if (candidateBytes > 512 * 1024) throw new Error('Complete project history exceeds the request size limit');
            candidates.push(candidate);
        };
        const consumeRows = async (rows: ResolvedCatalogHeader[], total: number, publish: boolean) => {
            for (let index = 0; index < rows.length; index++) {
                current(); const row = rows[index];
                if (versions.has(row.id)) throw new Error('Project history catalog contains duplicate identities');
                versions.set(row.id, row.metadataVersion);
                if (versions.size > 20_000 || versions.size > total) throw new Error('Project history catalog total is invalid');
                catalogBytes += encoder.encode(JSON.stringify(row)).byteLength;
                if (catalogBytes > 64 * 1024 * 1024) throw new Error('Project history catalog exceeds the size limit');
                if ('candidate' in row) {
                    if (row.candidate !== null) append(row.candidate);
                } else {
                    const key = row.dataEncryptionKey ? await encryption.decryptEncryptionKey(row.dataEncryptionKey) : null;
                    current();
                    if (row.dataEncryptionKey && !key) throw new Error('Project history record key could not be decrypted');
                    const prepared = await encryption.prepareSessionEncryption(row.id, key); current();
                    const metadata = await prepared.sessionEncryption.decryptMetadata(row.metadataVersion, row.metadata); current();
                    if (!metadata) throw new Error('Project history metadata could not be decrypted');
                    let candidate: GoalProjectConversationCandidate | null = null;
                    if (metadata.machineId === machineId) {
                        if (typeof metadata.path !== 'string' || !metadata.path) throw new Error('Project history metadata has no directory');
                        candidate = { sessionId: row.id, metadataVersion: row.metadataVersion, directory: metadata.path,
                            title: (metadata.name || metadata.summary?.text || '').slice(0, 2048),
                            ...(metadata.goalBoard?.featurePath ? { featurePath: metadata.goalBoard.featurePath } : {}),
                            ...(metadata.goalBoard?.taskId ? { taskId: metadata.goalBoard.taskId } : {}),
                            ...(metadata.lifecycleState ? { lifecycleState: metadata.lifecycleState } : {}) };
                        append(candidate);
                    }
                    indexEntries.push({ id: row.id, metadataVersion: row.metadataVersion, candidate });
                }
                if (index % 32 === 31) {
                    if (publish) progress(versions.size, total);
                    await new Promise<void>(resolve => setTimeout(resolve, 0));
                }
            }
        };
        do {
            current();
            const input = {
                projectPath, ...(snapshot ? { snapshotId: snapshot.snapshotId, cursor } : { format: 'manifest' }),
            };
            let response: unknown = await (version
                ? projectGoalRequest(machineId, 'goalProjectConversationCatalog', input, version)
                : projectGoalRequest(machineId, 'goalProjectConversationCatalog', input));
            rememberSnapshot(response);
            current();
            if (encoder.encode(JSON.stringify(response)).byteLength > 256 * 1024) throw new Error('Project history catalog page exceeds the size limit');
            const format = response && typeof response === 'object' && 'format' in response ? response.format : undefined;
            const manifestResponse = format === 'manifest';
            if (format !== undefined && !manifestResponse) throw new Error('Project history catalog format is invalid');
            if (manifestResponse) {
                if (snapshot) throw new Error('Project history catalog format changed between pages');
                const first = GoalProjectConversationCatalogManifestPageSchema.parse(response);
                if (first.projectPath !== projectPath || first.expiresAt <= Date.now()) throw new Error('Project history manifest scope changed or expired');
                indexSupported = first.indexSupported === true;
                const manifest = { ...first, sessions: [...first.sessions] };
                const seen = new Set(first.sessions.map(row => row.id)), manifestCursors = new Set<string>();
                let part = first;
                while (part.hasNext) {
                    if (!part.sessions.length || !part.nextCursor || manifestCursors.has(part.nextCursor)) throw new Error('Project history manifest cursor did not advance');
                    manifestCursors.add(part.nextCursor);
                    current();
                    const nextInput = { projectPath, snapshotId: first.snapshotId, cursor: part.nextCursor, format: 'manifest' };
                    const next = await (version ? projectGoalRequest(machineId, 'goalProjectConversationCatalog', nextInput, version)
                        : projectGoalRequest(machineId, 'goalProjectConversationCatalog', nextInput));
                    current();
                    if (encoder.encode(JSON.stringify(next)).byteLength > 256 * 1024) throw new Error('Project history manifest page exceeds the size limit');
                    part = GoalProjectConversationCatalogManifestPageSchema.parse(next);
                    if (part.projectPath !== first.projectPath || part.snapshotId !== first.snapshotId || part.catalogFingerprint !== first.catalogFingerprint
                        || part.total !== first.total || part.expiresAt !== first.expiresAt || part.indexSupported !== first.indexSupported) throw new Error('Project history manifest changed between pages');
                    for (const row of part.sessions) {
                        if (seen.has(row.id)) throw new Error('Project history manifest contains duplicate identities');
                        seen.add(row.id); manifest.sessions.push(row);
                    }
                    if (manifest.sessions.length > first.total) throw new Error('Project history manifest total is invalid');
                }
                if (manifest.projectPath !== projectPath || manifest.expiresAt <= Date.now() || part.nextCursor
                    || seen.size !== manifest.sessions.length || manifest.sessions.length !== manifest.total) throw new Error('Project history manifest is incomplete or expired');
                const pairs = manifest.sessions.map(row => [row.id, row.metadataVersion] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
                const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(pairs)));
                current();
                if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') !== manifest.catalogFingerprint)
                    throw new Error('Project history manifest fingerprint is invalid');
                progress(0, manifest.total);
                await readProjectConversationManifestHeaders(machineId, projectPath, manifest, { current, version, onRows: async rows => {
                    await consumeRows(rows, manifest.total, true); progress(versions.size, manifest.total);
                } });
                current();
                // A local reconstruction, not one oversized transport frame.
                // Each actual manifest/repair RPC was bounded independently.
                response = { ...first, sessions: [], hasNext: false, nextCursor: null };
            }
            const page = GoalProjectConversationCatalogPageSchema.parse(response);
            if (page.projectPath !== projectPath) throw new Error('Project history catalog scope changed');
            if (!snapshot) snapshot = page;
            else if (page.snapshotId !== snapshot.snapshotId || page.catalogFingerprint !== snapshot.catalogFingerprint
                || page.total !== snapshot.total || page.expiresAt !== snapshot.expiresAt) throw new Error('Project history catalog changed between pages');
            if (page.expiresAt <= Date.now()) throw new Error('Project history catalog expired; refresh conversations');
            if (!manifestResponse) await consumeRows(page.sessions, page.total, false);
            current();
            if (!page.hasNext) {
                if (page.nextCursor || versions.size !== page.total) throw new Error('Project history catalog is incomplete');
                progress(versions.size, page.total);
                break;
            }
            if (!page.sessions.length || !page.nextCursor || page.nextCursor === cursor || cursors.has(page.nextCursor))
                throw new Error('Project history catalog cursor did not advance');
            cursors.add(page.nextCursor);
            cursor = page.nextCursor;
            progress(versions.size, page.total);
        } while (cursor);
        const input = JSON.stringify([...versions].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        const hash = await crypto.subtle.digest('SHA-256', encoder.encode(input));
        current();
        const fingerprint = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (!snapshot || fingerprint !== snapshot.catalogFingerprint) throw new Error('Project history catalog fingerprint is invalid');
        if (indexSupported && indexEntries.length) {
            const base = { projectPath, snapshotId: snapshot.snapshotId, catalogFingerprint: fingerprint };
            let batch: ClassifiedCatalogHeader[] = [], bytes = encoder.encode(JSON.stringify({ ...base, entries: [] })).byteLength;
            const flush = async () => {
                if (!batch.length) return;
                current();
                const result = await projectGoalRequest(machineId, 'goalProjectConversationIndex', { ...base, entries: batch });
                current();
                if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true)
                    throw new Error('Project history classification index could not be saved');
                batch = []; bytes = encoder.encode(JSON.stringify({ ...base, entries: [] })).byteLength;
            };
            for (const entry of indexEntries) {
                const size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
                if (batch.length >= 200 || bytes + size > 192 * 1024) await flush();
                if (bytes + size > 192 * 1024) throw new Error('Project history classification exceeds the request size limit');
                batch.push(entry); bytes += size;
            }
            await flush();
        }
        entry.expiresAt = snapshot.expiresAt;
        entry.total = snapshot.total;
        return { candidates, catalogFingerprint: fingerprint, catalogSnapshotId: snapshot.snapshotId };
    })();
    entry.pending = Promise.race([read, cancelled]).then(result => {
        current();
        entry.complete = true;
        return result;
    }).catch(error => {
        evict();
        throw error;
    }).finally(() => { detach(); entry.reading = false; void releaseIdle(entry); });
    return acquire(entry, false, true);
}
