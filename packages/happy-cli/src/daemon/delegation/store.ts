import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DelegationRoleSchema, DelegatedTaskVersionSchema, type DelegationRole, type DelegatedTaskVersion } from '@slopus/happy-wire';

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
    return {
        directory, journalDirectory,
        loadRoles(): DelegationRole[] {
            const values = readDelegationJson<unknown[]>(directory, 'roles.json') ?? [];
            if (!Array.isArray(values) || values.length > 100) throw new Error('Invalid delegation roles');
            return values.map(value => DelegationRoleSchema.parse(value));
        },
        saveRoles(values: DelegationRole[]): void { writeDelegationJson(directory, 'roles.json', values.map(value => DelegationRoleSchema.parse(value))); },
        loadTasks(): StoredDelegationTask[] {
            return readdirSync(tasksDirectory).filter(name => /^task-[a-f0-9-]{36}\.json$/.test(name)).map(name => {
                const task = readDelegationJson<StoredDelegationTask>(tasksDirectory, name);
                if (!task || name !== `task-${task.id}.json` || !/^[a-f0-9-]{36}$/.test(task.id)
                    || !safeId.test(task.parentSessionId) || !/^[a-f0-9]{64}$/.test(task.nonce)
                    || !Array.isArray(task.versions) || task.versions.length < 1 || task.versions.length > 100) throw new Error('Invalid delegation task');
                task.role = DelegationRoleSchema.parse(task.role);
                task.versions.forEach((version, index) => {
                    publicDelegationVersion(version);
                    if (version.version !== index + 1 || !safeId.test(version.requestId)
                        || !/^[a-f0-9]{64}$/.test(version.inputHash) || !['prepared', 'spawning', 'sending', 'sent'].includes(version.phase)
                        || !Number.isInteger(version.reportSequence) || version.reportSequence < 0) throw new Error('Invalid delegation revision');
                });
                return task;
            });
        },
        saveTask(task: StoredDelegationTask): void {
            assertDelegationId(task.id);
            writeDelegationJson(tasksDirectory, `task-${task.id}.json`, task);
        },
    };
}
