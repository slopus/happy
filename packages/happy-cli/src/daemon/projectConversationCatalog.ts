import { createHash, randomBytes } from 'node:crypto';
import { GoalProjectConversationCatalogHeaderSchema, type GoalProjectConversationCatalogPage, type GoalProjectConversationCatalogManifestPage } from '@slopus/happy-wire';

export type ProjectConversationRawHeader = {
    id: string; metadata: string; metadataVersion?: number; dataEncryptionKey?: string | null;
    seq: number; updatedAt: number; active: boolean;
};
const MAX_RECORDS = 20000, MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024, MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_SNAPSHOTS = 32;
const PAGE_BYTES = 256 * 1024, TTL = 5 * 60 * 1000;
type Snapshot = {
    id: string; projectPath: string; fingerprint: string; expiresAt: number; bytes: number;
    sessions: ReadonlyArray<Readonly<ProjectConversationRawHeader>>;
    byId: ReadonlyMap<string, Readonly<ProjectConversationRawHeader>>;
};

/** This store belongs to one daemon account/machine runtime. Tokens never cross
 * that closure or persist. Expiration is checked only on user reads; a new
 * creation never evicts a token before its advertised expiry. */
export function createProjectConversationCatalog(load: () => Promise<ProjectConversationRawHeader[]>, now: () => number = Date.now) {
    let disposed = false;
    const assertActive = () => { if (disposed) throw new Error('Conversation catalog runtime is disposed'); };
    const snapshots = new Map<string, Snapshot>();
    const pendingLoads = new Map<string, Promise<ProjectConversationRawHeader[]>>();
    const pendingReaders = new Set<symbol>();
    const prune = () => { for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now()) snapshots.delete(id); };
    const residentBytes = () => [...snapshots.values()].reduce((total, snapshot) => total + snapshot.bytes, 0);
    const busy = () => new Error('Conversation catalog creation is busy; retry after the current read');
    const get = (projectPath: string, id: string) => {
        assertActive(); prune();
        const value = snapshots.get(id);
        if (!value || value.projectPath !== projectPath) throw new Error('Conversation catalog snapshot is expired, unavailable, or belongs to another project; refresh conversations');
        return value;
    };
    const loadHeaders = (projectPath: string) => {
        const existing = pendingLoads.get(projectPath);
        if (existing) return existing;
        let resolveSource!: (source: ProjectConversationRawHeader[]) => void, rejectSource!: (reason: unknown) => void;
        const request = new Promise<ProjectConversationRawHeader[]>((resolve, reject) => { resolveSource = resolve; rejectSource = reject; });
        // Register before invoking the source so simultaneous readers share only
        // its I/O, never ownership of the token that a reader may release.
        pendingLoads.set(projectPath, request);
        const clear = () => { if (pendingLoads.get(projectPath) === request) pendingLoads.delete(projectPath); };
        void (async () => load())().then(source => { clear(); resolveSource(source); }, error => { clear(); rejectSource(error); });
        return request;
    };
    const create = async (projectPath: string) => {
        assertActive();
        prune();
        // Every reader receives its own immutable snapshot. Reserve its maximum
        // payload before I/O even when another reader shares the source load.
        if (snapshots.size + pendingReaders.size >= MAX_SNAPSHOTS
            || residentBytes() + (pendingReaders.size + 1) * MAX_SNAPSHOT_BYTES > MAX_TOTAL_BYTES) throw busy();
        const reader = Symbol();
        pendingReaders.add(reader);
        try {
            const source = await loadHeaders(projectPath);
            assertActive();
            if (source.length > MAX_RECORDS) throw new Error('Conversation catalog record limit exceeded');
            const ids = new Set<string>(), sessions: Array<Readonly<ProjectConversationRawHeader>> = [];
            let bytes = 2;
            for (const raw of source) {
                const header = GoalProjectConversationCatalogHeaderSchema.parse(raw);
                if (ids.has(header.id)) throw new Error('Conversation catalog contains duplicate session IDs');
                ids.add(header.id);
                if (!Number.isSafeInteger(raw.seq) || raw.seq < 0 || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0 || typeof raw.active !== 'boolean')
                    throw new Error('Conversation catalog contains invalid session state');
                // Reserve enough envelope space for the canonical project path and
                // cursor. A single oversized header must never silently disappear.
                if (Buffer.byteLength(JSON.stringify(header)) + Buffer.byteLength(projectPath) + 1024 >= PAGE_BYTES)
                    throw new Error('Conversation catalog header exceeds the page byte limit');
                const session = Object.freeze({ ...header, seq: raw.seq, updatedAt: raw.updatedAt, active: raw.active });
                bytes += Buffer.byteLength(JSON.stringify(session)) + 1;
                if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Conversation catalog snapshot byte limit exceeded');
                sessions.push(session);
            }
            const pairs = sessions.map(row => [row.id, row.metadataVersion] as const).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            const snapshot: Snapshot = { id: randomBytes(24).toString('base64url'), projectPath,
                fingerprint: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
                expiresAt: now() + TTL, bytes, sessions: Object.freeze(sessions), byId: new Map(sessions.map(row => [row.id, row])) };
            prune();
            if (snapshots.size + pendingReaders.size > MAX_SNAPSHOTS
                || residentBytes() + bytes + (pendingReaders.size - 1) * MAX_SNAPSHOT_BYTES > MAX_TOTAL_BYTES) throw busy();
            // Convert this reservation into its actual resident size atomically.
            pendingReaders.delete(reader);
            snapshots.set(snapshot.id, snapshot);
            return snapshot;
        } finally { pendingReaders.delete(reader); }
    };
    type PageInput = { snapshotId?: string; cursor?: string; format?: 'manifest'; sessionIds?: string[] };
    function page(projectPath: string, input: PageInput & { format: 'manifest' }): Promise<GoalProjectConversationCatalogManifestPage>;
    function page(projectPath: string, input: PageInput & { format?: undefined }): Promise<GoalProjectConversationCatalogPage>;
    function page(projectPath: string, input: PageInput): Promise<GoalProjectConversationCatalogPage | GoalProjectConversationCatalogManifestPage>;
    async function page(projectPath: string, input: PageInput): Promise<GoalProjectConversationCatalogPage | GoalProjectConversationCatalogManifestPage> {
        if (input.format !== undefined && input.format !== 'manifest') throw new Error('Invalid conversation catalog format');
        if (input.cursor !== undefined && !input.snapshotId) throw new Error('A conversation catalog cursor requires its snapshot');
        let selectedIds: string[] | undefined;
        if (input.sessionIds !== undefined) {
            if (!input.snapshotId) throw new Error('A conversation catalog session selection requires its snapshot');
            if (input.format === 'manifest') throw new Error('A conversation catalog manifest cannot select ciphertext session IDs');
            if (!Array.isArray(input.sessionIds) || input.sessionIds.length > 200 ||
                input.sessionIds.some(id => typeof id !== 'string' || !id || id.length > 2048))
                throw new Error('Invalid conversation catalog session selection');
            selectedIds = [...new Set(input.sessionIds)];
        }
        const snapshot = input.snapshotId ? get(projectPath, input.snapshotId) : await create(projectPath);
        // Selection uses only this immutable snapshot. A missing ID rejects the
        // complete request rather than returning a plausible partial selection.
        const sessions = selectedIds === undefined ? snapshot.sessions : selectedIds.map(id => {
            const row = snapshot.byId.get(id);
            if (!row) throw new Error('Conversation catalog session selection contains an unknown session ID');
            return row;
        });
        if (input.cursor !== undefined && !/^(0|[1-9]\d*)$/.test(input.cursor)) throw new Error('Invalid conversation catalog cursor');
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        if (!Number.isSafeInteger(offset) || offset < 0 || (offset >= sessions.length && offset !== 0)) throw new Error('Invalid conversation catalog cursor');
        const envelope = { projectPath, snapshotId: snapshot.id, catalogFingerprint: snapshot.fingerprint,
            total: sessions.length, nextCursor: null as string | null, hasNext: false, expiresAt: snapshot.expiresAt };
        const manifestRows: GoalProjectConversationCatalogManifestPage['sessions'] = [];
        const rawRows: GoalProjectConversationCatalogPage['sessions'] = [];
        const manifest = input.format === 'manifest';
        const result = manifest ? { ...envelope, format: 'manifest' as const, sessions: manifestRows } : { ...envelope, sessions: rawRows };
        let bytes = Buffer.byteLength(JSON.stringify(result));
        for (let i = offset; i < sessions.length; i++) {
            const row = sessions[i];
            const identity = { id: row.id, metadataVersion: row.metadataVersion! };
            const header = manifest ? identity : { ...identity, metadata: row.metadata, dataEncryptionKey: row.dataEncryptionKey! };
            const size = Buffer.byteLength(JSON.stringify(header)) + 1;
            if (bytes + size + 128 >= PAGE_BYTES) break;
            if ('metadata' in header) rawRows.push(header);
            else manifestRows.push(header);
            bytes += size;
        }
        const next = offset + result.sessions.length;
        result.hasNext = next < sessions.length;
        result.nextCursor = result.hasNext ? String(next) : null;
        if (result.hasNext && !result.sessions.length) throw new Error('Conversation catalog page did not advance');
        if (Buffer.byteLength(JSON.stringify(result)) >= PAGE_BYTES) throw new Error('Conversation catalog page byte limit exceeded');
        return result;
    }
    return {
        dispose() { disposed = true; snapshots.clear(); pendingLoads.clear(); pendingReaders.clear(); },
        page,
        release(projectPath: string, snapshotId: string): boolean {
            assertActive(); prune();
            const snapshot = snapshots.get(snapshotId);
            if (!snapshot || snapshot.projectPath !== projectPath) return false;
            snapshots.delete(snapshotId);
            return true;
        },
        read(projectPath: string, snapshotId: string, fingerprint?: string) {
            const snapshot = get(projectPath, snapshotId);
            if (fingerprint !== snapshot.fingerprint) throw new Error('Conversation catalog snapshot fingerprint does not match');
            return snapshot.sessions;
        },
    };
}
