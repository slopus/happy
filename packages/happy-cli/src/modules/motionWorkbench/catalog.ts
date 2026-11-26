/** Project discovery never launches an engine. The private index stores paths, not an editable document copy. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, opendir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { MotionProjectSchema, type MotionProject } from '@slopus/happy-wire';
import { configuration } from '@/configuration';

const registration = z.object({ projectPath: z.string().min(1).max(4096), lastOpenedAt: z.number().nonnegative().optional() }).strict();
const ignored = new Set(['node_modules', '.git', '.tmp', '.expo', '.next', '.cache', 'dist', 'build', 'target', 'vendor']);
type ResolveProject = (directory: string, projectPath: string) => Promise<string>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function jsonFile(path: string, limit: number): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('Invalid project metadata');
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
            const read = await file.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
        }
        if (length > stat.size) throw new Error('Project metadata changed while reading');
        return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } finally { await file.close(); }
}

export function createMotionProjectCatalog(directory: string, resolveProject: ResolveProject, storageDirectory?: string) {
    async function locations() {
        const root = await realpath(directory);
        const storage = join(storageDirectory ?? join(configuration.happyHomeDir, 'motion-projects'), hash(JSON.stringify([configuration.serverUrl, root])));
        return { root, storage };
    }
    async function describe(root: string, projectPath: string, lastOpenedAt?: number): Promise<MotionProject> {
        const project = await resolveProject(root, projectPath);
        let title = project.split('/').filter(Boolean).pop() || 'MotionHarness', modifiedAt = 0;
        try {
            const doc = z.object({ title: z.string().optional() }).parse(await jsonFile(join(project, 'document.json'), 2 * 1024 * 1024));
            title = doc.title?.trim() || title;
            const file = await open(join(project, 'document.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try { modifiedAt = (await file.stat()).mtimeMs; } finally { await file.close(); }
        } catch { /* A new project can have no saved document yet. */ }
        return MotionProjectSchema.parse({ projectId: hash(JSON.stringify(['motionharness', project])), projectPath: project, title: title.slice(0, 200), modifiedAt, ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }) });
    }
    async function remember(storage: string, projectPath: string, lastOpenedAt?: number) {
        await mkdir(storage, { recursive: true, mode: 0o700 });
        const file = join(storage, hash(projectPath) + '.json');
        const temporary = file + '.' + randomUUID() + '.tmp';
        let previous: z.infer<typeof registration> | undefined;
        try { previous = registration.parse(await jsonFile(file, 8192)); } catch { /* First registration. */ }
        try {
            await writeFile(temporary, JSON.stringify({ projectPath, ...(previous?.lastOpenedAt === undefined && lastOpenedAt === undefined ? {} : { lastOpenedAt: Math.max(previous?.lastOpenedAt ?? 0, lastOpenedAt ?? 0) }) }), { mode: 0o600, flag: 'wx' });
            await rename(temporary, file);
        } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    }
    return {
        async register(projectPath: string, opened = false) {
            const { root, storage } = await locations();
            const project = await describe(root, projectPath, opened ? Date.now() : undefined);
            await remember(storage, project.projectPath, project.lastOpenedAt);
            return project;
        },
        async list() {
            const { root, storage } = await locations();
            const projects = new Map<string, MotionProject>(); let truncated = false;
            try {
                let records = 0;
                for await (const entry of await opendir(storage)) {
                    if (++records > 1000 || projects.size >= 100) { truncated = true; break; }
                    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
                    try {
                        const item = registration.parse(await jsonFile(join(storage, entry.name), 8192));
                        const project = await describe(root, item.projectPath, item.lastOpenedAt);
                        projects.set(project.projectPath, project);
                    } catch { /* Missing/invalid/out-of-scope registrations cannot authorize an open. */ }
                }
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const queue = [{ path: root, depth: 0 }]; let visited = 0, entriesRead = 0;
            for (let cursor = 0; cursor < queue.length; cursor++) {
                if (++visited > 1000 || entriesRead >= 10000 || projects.size >= 100) { truncated = true; break; }
                const current = queue[cursor];
                const folders: string[] = [];
                let hasConfig = false;
                try {
                    const canonical = await realpath(current.path), child = relative(root, canonical);
                    if (child === '..' || child.startsWith('../') || isAbsolute(child)) continue;
                    for await (const entry of await opendir(canonical)) {
                        if (++entriesRead > 10000) { truncated = true; break; }
                        if (entry.name === 'mh.json' && entry.isFile()) { hasConfig = true; break; }
                        if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) {
                            if (folders.length < 1000) folders.push(entry.name);
                            else truncated = true;
                        }
                    }
                } catch { truncated = true; continue; }
                if (hasConfig) {
                    try {
                        const item = await describe(root, current.path, projects.get(current.path)?.lastOpenedAt);
                        projects.set(item.projectPath, item); await remember(storage, item.projectPath, item.lastOpenedAt);
                    } catch { /* Non-Pro and invalid projects are not editable by this adapter. */ }
                    continue;
                }
                if (current.depth >= 6) { if (folders.length) truncated = true; continue; }
                for (const folder of folders) {
                    if (queue.length >= 1000) { truncated = true; break; }
                    queue.push({ path: join(current.path, folder), depth: current.depth + 1 });
                }
            }
            return { projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || b.modifiedAt - a.modifiedAt || a.title.localeCompare(b.title)), truncated };
        },
    };
}
