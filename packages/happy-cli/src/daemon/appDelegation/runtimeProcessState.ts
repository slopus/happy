import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { processAlive } from './workerLock';

const stateSchema = z.discriminatedUnion('phase', [
    z.object({ version: z.literal(1), generation: z.string().uuid(), phase: z.literal('launch-pending'), pid: z.null() }).strict(),
    z.object({ version: z.literal(1), generation: z.string().uuid(), phase: z.literal('running'), pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
type ProcessState = z.infer<typeof stateSchema>;
const marker = '.runtime-process.json';
export interface RuntimeProcessGuard {
    /** Must finish before spawn. An interrupted launch remains unsafe even if an old PID is dead. */
    beforeSpawn(): Promise<string>;
    spawned(generation: string, pid: number): Promise<void>;
}
async function readState(root: string): Promise<ProcessState> {
    const file = await open(join(root, marker), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024) throw new Error('invalid-runtime-process-state');
        const buffer = Buffer.alloc(1025);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024) throw new Error('invalid-runtime-process-state');
        return stateSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
    } finally { await file.close(); }
}
async function writeState(root: string, state: ProcessState): Promise<void> {
    const temporary = join(root, `.runtime-process-${randomUUID()}`);
    try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(stateSchema.parse(state))); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, join(root, marker));
        if (process.platform !== 'win32') {
            const directory = await open(root, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally { await rm(temporary, { force: true }); }
}
/** One job owns this guard. Machine-wide locking remains the caller's responsibility. */
export function createRuntimeProcessGuard(root: string): RuntimeProcessGuard {
    let pending: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = pending.then(operation);
        pending = result.catch(() => undefined);
        return result;
    };
    return {
        beforeSpawn: () => serialize(async () => {
            let previous: ProcessState | undefined;
            try { previous = await readState(root); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('runtime-launch-changed');
            }
            if (previous && (previous.phase === 'launch-pending' || processAlive(previous.pid))) throw new Error('resource-busy');
            const generation = randomUUID();
            await writeState(root, { version: 1, generation, phase: 'launch-pending', pid: null });
            return generation;
        }),
        spawned: (generation, pid) => serialize(async () => {
            const current = await readState(root);
            if (current.phase !== 'launch-pending' || current.generation !== generation) throw new Error('runtime-launch-changed');
            await writeState(root, { version: 1, generation, phase: 'running', pid });
        }),
    };
}
/** No fallback to old PID markers. Missing, malformed, and pending evidence cannot prove death. */
export async function canRecoverRuntimeProcess(root: string): Promise<boolean> {
    try {
        const state = await readState(root);
        return state.phase === 'running' && !processAlive(state.pid);
    } catch { return false; }
}
