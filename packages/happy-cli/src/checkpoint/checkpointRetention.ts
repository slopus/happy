import { readCheckpointRestoreJournal } from './checkpointRestoreJournal';
import { sweepStaleCheckpointDiffOperands } from './checkpointFileDiff';
import { withCheckpointStoreLock } from './checkpointStoreLock';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { CheckpointGarbageCollector, type RetentionPolicy } from './checkpointGarbageCollector';
import { resolveCheckpointStoreLayout } from './checkpointStore';

export const WORKTREE_HISTORY_GRACE_MS = 7 * 86400_000;
export const HISTORY_RETENTION = {
    maxCheckpointsPerBinding: 200,
    maxAgeMs: 30 * 86400_000,
    maxStoreBytes: 5 * 1024 ** 3,
    preserveLatest: true,
    capacityBudgetMs: 60_000,
} as const;
const identifier = z.string().min(1).max(128).refine(value => value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value));
const bindingSchema = z.object({ sessionId: identifier, projectId: identifier,
    worktreeId: identifier.nullable(), projectPath: z.string().min(1).max(4096) }).strict();
const retirementSchema = z.object({ schemaVersion: z.literal(1), projectId: identifier,
    worktreePath: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\u0000-\u001F\u007F]/.test(value)),
    action: z.enum(['inspect', 'retire']), immediate: z.boolean(), confirmed: z.literal(true).optional(),
}).strict().refine(value => !value.immediate || value.confirmed === true, 'immediate deletion requires confirmation');
const markerSchema = z.object({ missingSince: z.number().int().nonnegative(), immediate: z.boolean() }).strict();
type Binding = z.infer<typeof bindingSchema> & { key: string };
type Retirement = z.infer<typeof retirementSchema>;

/** Policy and deletion authority use daemon-owned binding metadata, never caller binding hashes. */
export class CheckpointRetention {
    private readonly gitDirectory: string;
    constructor(private readonly checkpointRoot: string) {
        this.gitDirectory = join(resolve(checkpointRoot), 'store');
    }

    async collect(now = Date.now()) {
        const result = await this.collectPolicy(now);
        await sweepStaleCheckpointDiffOperands(this.gitDirectory);
        return result;
    }

    async retireWorktree(params: unknown) {
        const request = retirementSchema.parse(params);
        const path = resolve(request.worktreePath);
        if (path !== request.worktreePath || !managedAnchor(path)) throw new Error('checkpoint retirement requires a managed worktree path');
        if (!(await trustedAnchor(path))) throw new Error('checkpoint retirement repository anchor is unavailable');
        if (request.action === 'retire' && await exists(path)) throw new Error('checkpoint retirement worktree still exists');
        // Inspect must succeed before Desktop deletes a worktree with immediate history deletion selected.
        if (request.action === 'inspect') {
            await this.matchBindings(request);
            return { ...request, status: 'supported' as const };
        }
        if (!request.immediate) {
            await this.markMissing(request);
            return { ...request, status: 'retained' as const };
        }
        await this.collectPolicy(Date.now(), request);
        const remaining = await this.matchBindings(request);
        return { ...request, status: remaining.length ? 'deferred' as const : 'deleted' as const };
    }

    /** A normal retirement only starts the grace clock; pruning and packing stay with the idle pass. */
    private async markMissing(request: Retirement) {
        if (!(await exists(this.gitDirectory))) return;
        await withCheckpointStoreLock(this.checkpointRoot, async () => {
            const now = Date.now();
            for (const binding of this.selectBindings((await this.readBindings()).bindings, request)) {
                const markerPath = join(this.gitDirectory, 'retention', `${binding.key}.json`);
                if (!(await readMarker(markerPath))) await writeMarker(markerPath, { missingSince: now, immediate: false });
            }
        });
    }

    /** With a request, only that worktree's bindings are retired; other limits wait for the idle pass. */
    private collectPolicy(now: number, request?: Retirement) {
        const policy: RetentionPolicy = { ...HISTORY_RETENTION, now, retireOnly: request !== undefined, resolveBindings: async () => {
            const keep = new Set<string>();
            const retire = new Set<string>();
            const safety = new Set<string>();
            const { bindings, unreadable } = await this.readBindings();
            if (request && unreadable.length > 0) throw new Error('checkpoint retirement binding metadata is unreadable');
            // Unreadable metadata cannot prove where its history belongs, so all of it is kept.
            for (const key of unreadable) keep.add(key);
            for (const binding of request ? this.selectBindings(bindings, request) : bindings) {
                const targeted = request !== undefined;
                try {
                    const restore = await this.restoreProtection(binding.key);
                    for (const id of restore.safetyIds) safety.add(`${binding.key}:${id}`);
                    const managed = managedAnchor(binding.projectPath);
                    const markerPath = join(this.gitDirectory, 'retention', `${binding.key}.json`);
                    if (!managed) { if (restore.pending) keep.add(binding.key); continue; } // Ordinary project history has only count/age/capacity retention.
                    if (!(await trustedAnchor(binding.projectPath))) { keep.add(binding.key); continue; }
                    if (await exists(binding.projectPath)) {
                        if (targeted) throw new Error('checkpoint retirement worktree still exists');
                        await rm(markerPath, { force: true });
                        if (restore.pending) keep.add(binding.key);
                        continue;
                    }
                    let marker = await readMarker(markerPath);
                    if (!marker) marker = { missingSince: now, immediate: false };
                    if (targeted) marker.immediate = true;
                    await writeMarker(markerPath, marker);
                    if (restore.pending) { keep.add(binding.key); continue; }
                    if (marker.immediate || now - marker.missingSince >= WORKTREE_HISTORY_GRACE_MS) retire.add(binding.key);
                    else keep.add(binding.key);
                } catch (error) {
                    if (targeted) throw error;
                    // I/O uncertainty, corrupt markers and unavailable mounts are never evidence of deletion.
                    keep.add(binding.key);
                }
            }
            return { keep, retire, safety };
        } };
        return new CheckpointGarbageCollector(this.checkpointRoot).collect(policy);
    }

    /** Explicit retirement fails closed: unreadable metadata might belong to the requested worktree. */
    private async matchBindings(request: Retirement) {
        const { bindings, unreadable } = await this.readBindings();
        if (unreadable.length > 0) throw new Error('checkpoint retirement binding metadata is unreadable');
        return this.selectBindings(bindings, request);
    }

    private selectBindings(bindings: Binding[], request: Retirement) {
        const samePath = bindings.filter(binding => binding.projectPath === request.worktreePath);
        if (samePath.some(binding => binding.projectId !== request.projectId)) throw new Error('checkpoint retirement binding mismatch');
        return samePath;
    }

    private async readBindings(): Promise<{ bindings: Binding[]; unreadable: string[] }> {
        const directory = join(this.gitDirectory, 'bindings');
        const names = await listDirectory(directory);
        const bindings: Binding[] = [];
        const unreadable: string[] = [];
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
            const file = join(directory, name);
            try {
                if (!(await lstat(file)).isFile()) throw new Error('checkpoint retention binding is not a regular file');
                const binding = bindingSchema.parse(JSON.parse(await readFile(file, 'utf8')));
                const layout = resolveCheckpointStoreLayout({ checkpointRoot: this.checkpointRoot, ...binding });
                if (layout.metadataFile !== file || resolve(binding.projectPath) !== binding.projectPath) {
                    throw new Error('checkpoint retention binding identity mismatch');
                }
                bindings.push({ ...binding, key: name.slice(0, -5) });
            } catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
                unreadable.push(name.slice(0, -5));
            }
        }
        return { bindings, unreadable };
    }

    private async restoreProtection(key: string): Promise<{ pending: boolean; safetyIds: string[] }> {
        let pending = false;
        const safetyIds: string[] = [];
        const directory = join(this.gitDirectory, 'restores', key);
        for (const name of await listDirectory(directory)) {
            if (!/^[a-f0-9]{64}\.json$/.test(name)) { pending = true; continue; }
            const journal = await readCheckpointRestoreJournal(join(directory, name));
            if (!journal) continue;
            safetyIds.push(journal.safetyCheckpointId);
            if (journal.entries.some(entry => !['restored', 'deleted', 'skipped', 'conflict'].includes(entry.outcome))) pending = true;
        }
        const stateFile = join(this.gitDirectory, 'protection', `${key}.json`);
        if (await exists(`${stateFile}.lock`)) pending = true;
        const state = await readFile(stateFile, 'utf8').catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
        });
        if (state !== null && (JSON.parse(state) as { pendingDecision?: unknown }).pendingDecision) pending = true;
        return { pending, safetyIds };
    }
}

function managedAnchor(path: string): { repository: string; worktrees: string } | null {
    const segment = `${sep}.aplus${sep}worktrees${sep}`;
    const start = path.lastIndexOf(segment);
    if (start < 1) return null;
    const repository = path.slice(0, start);
    const worktrees = join(repository, '.aplus', 'worktrees');
    const child = relative(worktrees, path).split(sep);
    if (child.length < 1 || child.length > 2 || child.some(part => !part || part === '.' || part === '..')) return null;
    return { repository, worktrees };
}

async function trustedAnchor(path: string): Promise<boolean> {
    const anchor = managedAnchor(path);
    if (!anchor) return false;
    try {
        if (await realpath(anchor.worktrees) !== anchor.worktrees || await realpath(anchor.repository) !== anchor.repository) return false;
        // A Git .git file is valid for repositories that themselves are worktrees.
        const git = await lstat(join(anchor.repository, '.git'));
        return git.isDirectory() || git.isFile();
    } catch { return false; }
}

async function exists(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}
async function listDirectory(path: string): Promise<string[]> {
    return readdir(path).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
}
async function readMarker(path: string) {
    try { return markerSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
    }
}
async function writeMarker(path: string, marker: z.infer<typeof markerSchema>) {
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
}
