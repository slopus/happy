import { mkdir, open, readdir, realpath, link, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { GoalTask } from '@slopus/happy-wire';
import { digest, readBoundedFile } from './parser';

export const isStableTaskId = (id: string) => /^GFT-[a-z0-9]{8}$/.test(id);

/** Append-only observations. A reused path remains ambiguous rather than stealing an old task. */
export function createTaskIdentityStore(storage: string) {
    const root = join(storage, 'task-identities');
    const read = async (path: string) => {
        try { return JSON.parse((await readBoundedFile(await realpath(root), await realpath(path), 32 * 1024)).toString('utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const writeOnce = async (path: string, value: unknown) => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing) {
            if (!existing.isFile()) throw new Error('Invalid task identity record');
            return;
        }
        const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close();
            await link(temporary, path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
        } finally { await file.close().catch(() => {}); await rm(temporary, { force: true }); }
    };
    const paths = async (id: string, migration = false): Promise<string[]> => {
        const folder = join(root, digest(id));
        const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
        if (names.length > 1000) throw new Error('Task identity observation limit exceeded');
        const values = await Promise.all(names.filter(name => /^[a-f0-9]{24}\.json$/.test(name)).map(name => read(join(folder, name))));
        const eligible: string[] = [];
        for (const value of values) {
            if (value?.id !== id || typeof value.directory !== 'string') continue;
            const owners = await readdir(join(root, 'paths', digest(value.directory))).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
            if (owners.filter(name => /^[a-f0-9]{24}\.json$/.test(name)).length === 1 ||
                migration && (await read(join(root, 'paths', digest(value.directory), 'first.json')))?.id === id) eligible.push(value.directory);
        }
        return eligible;
    };
    return {
        paths,
        hasPathHistory: async (directory: string) => {
            const names = await readdir(join(root, 'paths', digest(directory))).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
            return names.some(name => /^[a-f0-9]{24}\.json$/.test(name));
        },
        sessions: async (taskId: string): Promise<string[]> => {
            const folder = join(root, 'task-sessions', digest(taskId));
            const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
            if (names.length > 2000) throw new Error('Task session binding limit exceeded');
            const values = await Promise.all(names.filter(name => /^[a-f0-9]{24}\.json$/.test(name)).map(name => read(join(folder, name))));
            return values.filter(value => value?.taskId === taskId && typeof value.sessionId === 'string').map(value => value.sessionId);
        },
        allocate: async (indexPath: string, sourceHash: string) => {
            const path = join(root, 'allocations', `${digest(indexPath + ':' + sourceHash)}.json`);
            await writeOnce(path, { indexPath, sourceHash, taskId: `GFT-${randomUUID().replace(/-/g, '').slice(0, 8)}` });
            const value = await read(path);
            if (value?.indexPath !== indexPath || value.sourceHash !== sourceHash || !isStableTaskId(value.taskId)) throw new Error('Invalid task identity allocation');
            return value.taskId as string;
        },
        remember: async (task: GoalTask, directory = dirname(task.indexPath)) => {
            if (isStableTaskId(task.id)) {
                await writeOnce(join(root, 'paths', digest(directory), 'first.json'), { id: task.id, directory });
                await writeOnce(join(root, 'paths', digest(directory), `${digest(task.id)}.json`), { id: task.id, directory });
                await writeOnce(join(root, digest(task.id), `${digest(join(directory, 'index.md'))}.json`), { id: task.id, directory });
            }
        },
        session: async (sessionId: string): Promise<string | undefined> => {
            const value = await read(join(root, 'sessions', `${digest(sessionId)}.json`));
            return value?.sessionId === sessionId && isStableTaskId(value.taskId) ? value.taskId : undefined;
        },
        bind: async (sessionId: string, taskId: string) => {
            if (isStableTaskId(taskId)) {
                const path = join(root, 'sessions', `${digest(sessionId)}.json`);
                await writeOnce(path, { sessionId, taskId });
                if ((await read(path))?.taskId !== taskId) throw new Error('Session task binding changed');
                await writeOnce(join(root, 'task-sessions', digest(taskId), `${digest(sessionId)}.json`), { taskId, sessionId });
            }
        },
        /** Preserve once-only launch receipts and local history when migrating from path keys. */
        state: async (task: GoalTask) => {
            const directory = dirname(task.indexPath);
            const target = join(storage, isStableTaskId(task.id) ? `task-${digest(task.id)}` : digest(directory));
            await mkdir(target, { recursive: true, mode: 0o700 });
            if (isStableTaskId(task.id)) {
                for (const old of new Set(await paths(task.id, true))) {
                    const source = join(storage, digest(old));
                    for (const sub of ['', 'sessions']) {
                        const from = join(source, sub), to = join(target, sub);
                        const names = await readdir(from).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
                        if (names.length > 2000) throw new Error('Task receipt migration limit exceeded');
                        for (const name of names.filter(name => /^[a-z0-9-]+\.json$/.test(name))) {
                            await mkdir(to, { recursive: true, mode: 0o700 });
                            await writeOnce(join(to, name), JSON.parse((await readBoundedFile(await realpath(storage), await realpath(join(from, name)), 128 * 1024)).toString('utf8')));
                        }
                    }
                }
            }
            return realpath(target);
        },
    };
}
