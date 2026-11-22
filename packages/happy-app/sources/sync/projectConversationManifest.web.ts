import { GoalProjectConversationCandidateSchema, GoalProjectConversationCatalogPageSchema, type GoalProjectConversationCandidate } from '@slopus/happy-wire';
import { projectGoalRequest } from './projectGoals';

type Header = { id: string; metadataVersion: number; metadata: string; dataEncryptionKey: string | null };
export type ClassifiedCatalogHeader = { id: string; metadataVersion: number; candidate: GoalProjectConversationCandidate | null };
export type ResolvedCatalogHeader = Header | ClassifiedCatalogHeader;
type Manifest = { projectPath: string; snapshotId: string; catalogFingerprint: string; total: number; expiresAt: number;
    sessions: Array<{ id: string; metadataVersion: number; candidate?: GoalProjectConversationCandidate | null }> };
const BATCH = 200, MAX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

/** Reuse only explicit classifications. Unknown rows remain opaque and are
 * fetched from the original immutable snapshot; absence never means excluded. */
export async function readProjectConversationManifestHeaders(machineId: string, projectPath: string, manifest: Manifest,
    options: { current: () => void; version?: string; onRows?: (rows: ResolvedCatalogHeader[]) => Promise<void> }): Promise<ResolvedCatalogHeader[]> {
    const { current } = options; current();
    if (manifest.projectPath !== projectPath || manifest.sessions.length !== manifest.total || manifest.expiresAt <= Date.now()
        || new Set(manifest.sessions.map(row => row.id)).size !== manifest.total) throw new Error('Project history manifest is incomplete or expired');
    const versions = new Map(manifest.sessions.map(row => [row.id, row.metadataVersion]));
    const found = new Map<string, ResolvedCatalogHeader>(); let bytes = 2;
    const accept = (row: ResolvedCatalogHeader) => {
        bytes += encoder.encode(JSON.stringify(row)).byteLength + 1;
        if (bytes > MAX_BYTES) throw new Error('Project history catalog exceeds the size limit');
        found.set(row.id, row);
    };
    const known: ClassifiedCatalogHeader[] = [];
    for (const row of manifest.sessions) {
        if (row.candidate === undefined) continue;
        const candidate = row.candidate === null ? null : GoalProjectConversationCandidateSchema.parse(row.candidate);
        if (candidate && (candidate.sessionId !== row.id || candidate.metadataVersion !== row.metadataVersion))
            throw new Error('Project history candidate identity or version is invalid');
        const classified = { id: row.id, metadataVersion: row.metadataVersion, candidate }; accept(classified); known.push(classified);
    }
    if (known.length) { await options.onRows?.(known); current(); }
    const missing = manifest.sessions.filter(row => !found.has(row.id)).map(row => row.id);
    for (let start = 0; start < missing.length; start += BATCH) {
        const sessionIds = missing.slice(start, start + BATCH), seen = new Set<string>(), cursors = new Set<string>();
        let cursor: string | undefined;
        do {
            current();
            const input = { projectPath, snapshotId: manifest.snapshotId, sessionIds, ...(cursor ? { cursor } : {}) };
            const response = await (options.version ? projectGoalRequest(machineId, 'goalProjectConversationCatalog', input, options.version)
                : projectGoalRequest(machineId, 'goalProjectConversationCatalog', input));
            current();
            if (encoder.encode(JSON.stringify(response)).byteLength > 256 * 1024) throw new Error('Project history catalog page exceeds the size limit');
            const page = GoalProjectConversationCatalogPageSchema.parse(response);
            if (page.projectPath !== projectPath || page.snapshotId !== manifest.snapshotId || page.catalogFingerprint !== manifest.catalogFingerprint
                || page.expiresAt !== manifest.expiresAt || page.expiresAt <= Date.now() || page.total !== sessionIds.length)
                throw new Error('Project history snapshot changed during opaque-record retrieval');
            for (const row of page.sessions) {
                if (!sessionIds.includes(row.id) || versions.get(row.id) !== row.metadataVersion || seen.has(row.id))
                    throw new Error('Project history snapshot returned an invalid identity or version');
                seen.add(row.id); accept(row);
            }
            await options.onRows?.(page.sessions); current();
            if (!page.hasNext) {
                if (page.nextCursor || seen.size !== sessionIds.length) throw new Error('Project history snapshot is incomplete');
                break;
            }
            if (!page.sessions.length || !page.nextCursor || page.nextCursor === cursor || cursors.has(page.nextCursor))
                throw new Error('Project history snapshot cursor did not advance');
            cursors.add(page.nextCursor); cursor = page.nextCursor;
        } while (cursor);
    }
    current();
    if (found.size !== manifest.total) throw new Error('Project history manifest is incomplete');
    return manifest.sessions.map(row => found.get(row.id)!);
}
