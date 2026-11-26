/** Explicit, encrypted conversation references. Discovering/opening a project never links it. */
import { z } from 'zod';
import type { MotionProject } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { AsyncLock } from '@/utils/lock';
import { getServerUrl } from '@/sync/serverConfig';
import { storage } from '@/sync/storage';
import { sessionUpdateMetadata } from '@/sync/ops';
import type { Metadata } from '@/sync/storageTypes';

export type MotionArtifactLink = {
    projectId: string; projectPath: string; title: string; linkedAt: number; workspaceRoot: string;
};
const linkSchema = z.object({
    projectId: z.string().regex(/^[a-f0-9]{64}$/), projectPath: z.string().min(1).max(4096),
    title: z.string().trim().min(1).max(200), linkedAt: z.number().nonnegative().finite(),
    workspaceRoot: z.string().min(1).max(4096),
}).passthrough();
// Incoming thin references are commands, not persisted envelopes.
const projectSchema = linkSchema.pick({ projectId: true, projectPath: true, title: true }).strip();
const MAX_SESSION_MOTION_LINKS = 20;
const limitError = () => new Error('A conversation can reference at most 20 film projects.');
const locks = new Map<string, { lock: AsyncLock; users: number }>();
const pathKey = (path: string) => path.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
function inside(root: string, path: string): boolean {
    const canonicalRoot = pathKey(root), canonicalPath = pathKey(path);
    if (!/^(\/|[A-Za-z]:\/)/.test(canonicalRoot) || !/^(\/|[A-Za-z]:\/)/.test(canonicalPath)) return false;
    if (canonicalPath.split('/').some(part => part === '.' || part === '..')) return false;
    return canonicalPath === canonicalRoot || canonicalPath.startsWith(canonicalRoot === '/' ? '/' : canonicalRoot + '/');
}
function allLinks(metadata: unknown): MotionArtifactLink[] {
    const rows = (metadata as { motionProjectLinks?: unknown } | null | undefined)?.motionProjectLinks;
    if (!Array.isArray(rows)) return [];
    const unique = new Map<string, MotionArtifactLink>();
    for (const row of rows.slice(0, MAX_SESSION_MOTION_LINKS)) {
        const parsed = linkSchema.safeParse(row);
        if (!parsed.success || !inside(parsed.data.workspaceRoot, parsed.data.projectPath)) continue;
        const link = parsed.data;
        unique.set(JSON.stringify([pathKey(link.workspaceRoot), link.projectId]), link);
    }
    return [...unique.values()];
}
/** Workspace filtering is organizational only; RPC always revalidates the actual project path. */
export function loadMotionLinks(metadata: unknown, workspaceRoot?: string): MotionArtifactLink[] {
    return allLinks(metadata).filter(link => !workspaceRoot || pathKey(link.workspaceRoot) === pathKey(workspaceRoot));
}
function accountIdentity(): string {
    assertAccountRuntime();
    const selected = getRuntimeAccountSelection();
    return JSON.stringify([getServerUrl(), selected?.key, selected?.generation, selected?.serverUrl]);
}
function captureOwner(sessionId: string) {
    const account = accountIdentity();
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!metadata?.path || !metadata.machineId) throw new Error('Session workspace is unavailable.');
    const root = metadata.path, machineId = metadata.machineId;
    const assertMetadata = (value: Metadata | null | undefined) => {
        if (!value || value.path !== root || value.machineId !== machineId || value.conversationDeletePlan
            || ['archived', 'archiveRequested'].includes(value.lifecycleState ?? '')) throw new Error('Session workspace changed. Reopen its project artifacts.');
    };
    const assertCurrent = () => {
        if (accountIdentity() !== account) throw new Error('Account changed. Reopen project artifacts.');
        assertMetadata(storage.getState().sessions[sessionId]?.metadata);
    };
    assertCurrent();
    return { root, key: JSON.stringify([account, sessionId, machineId, root]), assertCurrent, assertMetadata };
}
async function updateLinks(sessionId: string, updater: (links: MotionArtifactLink[], root: string) => MotionArtifactLink[]): Promise<MotionArtifactLink[]> {
    const owner = captureOwner(sessionId);
    let entry = locks.get(owner.key);
    if (!entry) { entry = { lock: new AsyncLock(), users: 0 }; locks.set(owner.key, entry); }
    entry.users++;
    try {
        return await entry.lock.inLock(async () => {
            owner.assertCurrent();
            const source = storage.getState().sessions[sessionId];
            if (!source?.metadata) throw new Error('Session is unavailable.');
            const prepare = (metadata: Metadata): Metadata => {
                owner.assertCurrent(); owner.assertMetadata(metadata);
                // Count all stored roots against the metadata schema's session bound.
                // Invalid older overflow must not be silently truncated by a new write.
                const stored = (metadata as { motionProjectLinks?: unknown }).motionProjectLinks;
                if (Array.isArray(stored) && stored.length > MAX_SESSION_MOTION_LINKS) throw limitError();
                const before = allLinks(metadata), next = updater(before, owner.root);
                if (next.length > MAX_SESSION_MOTION_LINKS) throw limitError();
                if (JSON.stringify(before) === JSON.stringify(next)) return metadata;
                return { ...metadata, motionProjectLinks: next };
            };
            // Fail before calling the encrypted writer when the local boundary is
            // already known; recheck in prepare for a remote CAS conflict as well.
            prepare(source.metadata);
            const result = await sessionUpdateMetadata(sessionId, source.metadata, source.metadataVersion, prepare, 3, owner.assertCurrent);
            owner.assertCurrent(); owner.assertMetadata(result.metadata);
            const live = storage.getState().sessions[sessionId];
            if (live && live.metadataVersion <= result.version) {
                storage.getState().applySessions([{ ...live, metadata: result.metadata, metadataVersion: result.version }]);
            }
            return loadMotionLinks(result.metadata, owner.root);
        });
    } finally {
        entry.users--;
        if (!entry.users && locks.get(owner.key) === entry) locks.delete(owner.key);
    }
}
export async function linkMotionProject(sessionId: string, project: Pick<MotionProject, 'projectId' | 'projectPath' | 'title'>): Promise<MotionArtifactLink> {
    const verified = projectSchema.parse(project), linkedAt = Date.now();
    const links = await updateLinks(sessionId, (current, root) => {
        if (!inside(root, verified.projectPath)) throw new Error('Choose a project inside this conversation workspace.');
        const prior = current.find(link => pathKey(link.workspaceRoot) === pathKey(root) && link.projectId === verified.projectId);
        const next: MotionArtifactLink = { ...prior, ...verified, linkedAt: prior?.linkedAt ?? linkedAt, workspaceRoot: root };
        return [...current.filter(link => !(pathKey(link.workspaceRoot) === pathKey(root)
            && (link.projectId === verified.projectId || link.projectPath === verified.projectPath))), next];
    });
    const link = links.find(value => value.projectId === verified.projectId);
    if (!link) throw new Error('The project association could not be confirmed.');
    return link;
}
export async function unlinkMotionProject(sessionId: string, projectId: string): Promise<void> {
    const id = z.string().regex(/^[a-f0-9]{64}$/).parse(projectId);
    await updateLinks(sessionId, (links, root) => links.filter(link => pathKey(link.workspaceRoot) !== pathKey(root) || link.projectId !== id));
}
