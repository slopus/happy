import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { DelegationRoleSchema, DelegatedTaskSummarySchema, DelegatedTaskVersionSchema, type DelegationRole, type DelegatedTaskVersion } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';

export type DelegationPhase = 'prepared' | 'spawning' | 'sending' | 'sent';
export interface StoredDelegationVersion extends DelegatedTaskVersion {
    requestId: string;
    inputHash: string;
    phase: DelegationPhase;
    reportSequence: number;
    turnId?: string;
    cancelRequested?: boolean;
}
export interface StoredDelegationTask {
    id: string;
    parentSessionId: string;
    title: string;
    role: DelegationRole;
    /** This role-shaped route snapshot is task-local and is never saved in roles.json. */
    temporaryRoute?: boolean;
    childSessionId?: string;
    nonce: string;
    createdAt: number;
    versions: StoredDelegationVersion[];
}

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const storedVersionSchema = DelegatedTaskVersionSchema.extend({
    requestId: z.string().regex(safeId),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    phase: z.enum(['prepared', 'spawning', 'sending', 'sent']),
    reportSequence: z.number().int().nonnegative(),
    turnId: z.string().min(1).max(256).optional(),
    cancelRequested: z.boolean().optional(),
});
const storedTaskSchema = DelegatedTaskSummarySchema.pick({ id: true, parentSessionId: true, childSessionId: true, title: true }).extend({
    id: DelegatedTaskSummarySchema.shape.id.regex(/^[a-f0-9-]{36}$/),
    role: DelegationRoleSchema,
    temporaryRoute: z.boolean().optional(),
    nonce: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: DelegationRoleSchema.shape.createdAt,
    versions: z.array(storedVersionSchema).min(1).max(100),
});
/**
 * Task histories have up to 100 revisions. Each revision permits 404,000 UTF-16
 * units of prompt/context/result/error plus bounded IDs and internal metadata.
 * JSON can use six bytes per unit (e.g. \u0000), so their worst-case strings use
 * less than 244 MB. Structure and task/role metadata fit within another 1 MiB;
 * 256 MiB leaves over 24 MiB of headroom without lifting journal read limits.
 */
const taskRecordMaxBytes = 256 * 1024 * 1024;
export function assertDelegationId(value: string): string {
    if (!safeId.test(value)) throw new Error('Invalid delegation identifier');
    return value;
}
export function ensureDelegationDirectory(directory: string): void {
    if (!isAbsolute(directory)) throw new Error('Delegation storage directory must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Delegation directory must be a real directory');
}

/** Replace one protected record; never follow a pre-existing destination symlink. */
export function writeDelegationJson(directory: string, name: string, value: unknown): void {
    if (!/^[a-zA-Z0-9_.-]+\.json$/.test(name)) throw new Error('Invalid delegation journal filename');
    ensureDelegationDirectory(directory);
    const target = join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        const file = openSync(temporary, 'r');
        try { fsyncSync(file); } finally { closeSync(file); }
        renameSync(temporary, target);
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}
export function readDelegationJson<T>(directory: string, name: string, maxBytes = 32 * 1024 * 1024): T | null {
    const path = join(directory, name);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Unsafe delegation record');
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}
export function delegationInputHash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function publicDelegationVersion(value: StoredDelegationVersion): DelegatedTaskVersion {
    return DelegatedTaskVersionSchema.parse({
        version: value.version, requestId: value.requestId,
        ...(value.intent && value.intent !== 'legacy-explicit' ? { intent: value.intent } : {}), prompt: value.prompt, context: value.context,
        status: value.status, startedAt: value.startedAt, updatedAt: value.updatedAt,
        finishedAt: value.finishedAt, error: value.error, result: value.result,
    });
}
export function createDelegationStore(directory: string) {
    ensureDelegationDirectory(directory);
    const tasksDirectory = join(directory, 'tasks');
    const journalDirectory = join(directory, 'journal');
    ensureDelegationDirectory(tasksDirectory);
    ensureDelegationDirectory(journalDirectory);
    const unreadableTasks = new Set<string>();
    return {
        directory, journalDirectory,
        loadRoles(): DelegationRole[] {
            const values = readDelegationJson<unknown[]>(directory, 'roles.json') ?? [];
            if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid delegation roles');
            return values.map(value => DelegationRoleSchema.parse(value));
        },
        saveRoles(values: DelegationRole[]): void { writeDelegationJson(directory, 'roles.json', values.map(value => DelegationRoleSchema.parse(value))); },
        loadTasks(): StoredDelegationTask[] {
            const names = readdirSync(tasksDirectory).filter(name => /^task-[a-f0-9-]{36}\.json$/.test(name));
            unreadableTasks.clear();
            return names.flatMap(name => {
                try {
                    const task = readDelegationJson<StoredDelegationTask>(tasksDirectory, name, taskRecordMaxBytes);
                    // Validate every stored field before allowing it into the live map.
                    // Keep the original history strings rather than a normalized copy.
                    storedTaskSchema.parse(task);
                    if (!task || name !== `task-${task.id}.json`) throw new Error('Invalid delegation task');
                    task.role = DelegationRoleSchema.parse(task.role);
                    task.versions.forEach((version, index) => {
                        if (version.version !== index + 1) throw new Error('Invalid delegation revision');
                    });
                    return [task];
                } catch (error) {
                    unreadableTasks.add(name);
                    // JSON/Zod errors may contain instruction/result text. Log only a
                    // fixed category and location, leaving the original record intact.
                    const reason = error instanceof SyntaxError ? 'invalid-json'
                        : error instanceof Error && error.name === 'ZodError' ? 'invalid-schema'
                        : error instanceof Error && error.message === 'Unsafe delegation record' ? 'unsafe-record'
                        : 'invalid-task';
                    logger.warn('[DELEGATION] Skipped unreadable task record; original file retained', { path: join(tasksDirectory, name), reason });
                    return [];
                }
            });
        },
        saveTask(task: StoredDelegationTask): void {
            assertDelegationId(task.id);
            const name = `task-${task.id}.json`;
            if (unreadableTasks.has(name)) throw new Error(`Cannot overwrite unreadable delegation task record; repair or move the original file and reload tasks first: ${name}`);
            writeDelegationJson(tasksDirectory, name, task);
        },
    };
}
