import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, rename, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { GoalTask, GoalTaskSession } from '@slopus/happy-wire';
import { discoverRoots, readCatalog, readProjects, safePath, within, catalogSummary, type CatalogRecord } from './catalog';
import { digest, goalFileRevision, goalOf, titleOf, parseBoard, readBoundedFile } from './parser';
import { goalBoardTaskPrompt } from './taskPrompt';
import { openAuthorizedFile } from './authorizedFiles';
import type { SpawnSessionOptions, SpawnSessionResult } from '../common/registerCommonHandlers';
import type { Metadata } from '@/api/types';

export type ProjectSession = GoalTaskSession & { metadata: Metadata };
type Receipt = { requestId: string; directory: string; state: 'starting' | 'submitted' | 'uncertain' | 'historical'; sessionId?: string; createdAt: number };
type Approval = { revision: string; hash: string; reviewedAt: number };
export type ProjectGoalDependencies = {
    homeDirectory?: string;
    workingDirectory: string;
    storageDirectory: string;
    observe?: boolean;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    send: (sessionId: string, prompt: string, localId: string) => Promise<void>;
    history: (featurePath: string, tasks: Array<{ id: string; directory: string; title?: string }>) => Promise<ProjectSession[]>;
    changed: () => void | Promise<void>;
    getArtifactStore?: () => Promise<import('../artifacts/store').ArtifactStore>;
};
const pathInput = z.string().min(1).max(8192);
const taskInput = z.object({ featurePath: pathInput, taskId: z.string().min(1).max(2048) });
const launchInput = taskInput.extend({
    requestId: z.string().min(1).max(128), action: z.enum(['chat', 'execute']),
    agent: z.enum(['codex', 'claude']), model: z.string().min(1).max(200).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(), codexSessionGrant: z.string().max(4096).optional(),
});
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Machine-scoped archive access. Every request resolves its own feature; no shared selection. */
export function createProjectGoalService(deps: ProjectGoalDependencies) {
    // macOS FSEvents can synchronously deadlock Node while opening/closing
    // directory watchers. Keep the daemon responsive: explicit reads remain
    // current, and service mutations still publish their changed event.
    const observe = deps.observe ?? process.platform !== 'darwin';
    let disposed = false;
    const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
    const inFlight = new Map<string, Promise<SpawnSessionResult>>();
    const transfers = new Map<string, { scope: boolean; featureReadOnly: boolean; featurePath: string; taskId?: string; directory: string; root: string; path: string; revision: string; expiresAt: number }>();
    const catalog = async () => readCatalog(await discoverRoots(deps.workingDirectory, deps.homeDirectory));
    const entryFor = async (featurePath: string) => {
        if (disposed) throw new Error('Project workspace is closed');
        const actual = await realpath(pathInput.parse(featurePath));
        const entry = (await catalog()).find(entry => entry.featurePath === actual);
        if (!entry) throw new Error('Feature is outside the authorized Goal catalog');
        return entry;
    };
    const scopeFor = async (scopePath: string) => {
        if (disposed) throw new Error('Project workspace is closed');
        const directory = await realpath(pathInput.parse(scopePath));
        const roots = await discoverRoots(deps.workingDirectory, deps.homeDirectory);
        const projects = await readProjects(roots);
        if (!projects.some(project => project.projectPath === directory || project.features.some(feature => feature.featurePath === directory)))
            throw new Error('Scope is outside the authorized Goal catalog');
        const root = roots.find(root => within(root, directory));
        if (!root) throw new Error('Scope root is unavailable');
        return { directory, root };
    };
    const overview = async (input: unknown) => {
        const { directory } = await scopeFor(z.object({ scopePath: pathInput }).parse(input).scopePath);
        const indexPath = join(directory, 'index.md');
        const source = (await readBoundedFile(directory, indexPath, 256 * 1024)).toString('utf8');
        let fileCount = 0, visited = 0, countComplete = true;
        const pending = [directory];
        // One bounded archive traversal per explicit/event-driven read. No timers.
        while (pending.length) {
            const path = pending.pop()!;
            try {
                if (await safePath(directory, path) !== path) { countComplete = false; continue; }
                const entries = await readdir(path, { withFileTypes: true });
                for (const entry of entries) {
                    if (++visited > 20000) { countComplete = false; pending.length = 0; break; }
                    if (entry.isFile()) fileCount++;
                    else if (entry.isDirectory()) pending.push(join(path, entry.name));
                    // Symlinks are not followed or counted as original files.
                }
            } catch { countComplete = false; }
        }
        return { success: true, overview: { scopePath: directory, indexPath, title: titleOf(source), goal: goalOf(source) || catalogSummary(source) || '', fileCount, countComplete, revision: digest(source) } };
    };
    const scopeHistory = async (input: unknown) => {
        const { directory } = await scopeFor(z.object({ scopePath: pathInput }).parse(input).scopePath);
        const source = await deps.history(directory, [{ id: '', directory }]);
        const sessions = source.filter(session => session.directory === directory && (!session.metadata.goalBoard || (!session.metadata.goalBoard.taskId && session.metadata.goalBoard.featurePath === directory)))
            .sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId))
            .slice(0, 25).map(({ metadata: _metadata, ...session }) => session);
        return { success: true, sessions };
    };
    const taskFor = async (input: unknown) => {
        const data = taskInput.parse(input);
        const entry = await entryFor(data.featurePath);
        const parsed = await parseBoard(entry, { featureOnly: true, finalOnly: true });
        const task = parsed.snapshot.tasks.find(task => task.id === data.taskId);
        if (!task) throw new Error('Task is not in this feature');
        const directory = await safePath(entry.root, dirname(task.indexPath));
        return { entry, task, directory };
    };
    const stateDirectory = async (directory: string) => {
        const target = join(deps.storageDirectory, digest(directory));
        await mkdir(target, { recursive: true, mode: 0o700 });
        return realpath(target);
    };
    const readJSON = async <T>(path: string): Promise<T | null> => {
        try { const bytes = await readBoundedFile(await realpath(deps.storageDirectory), path, 128 * 1024); return JSON.parse(bytes.toString('utf8')) as T; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    };
    const saveJSON = async (path: string, value: unknown) => {
        const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
    };
    const claim = async (path: string, value: unknown) => {
        try {
            const file = await open(path, 'wx', 0o600);
            try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
            return true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    };
    const belongs = (session: ProjectSession, task: GoalTask, featurePath: string, directory: string) =>
        session.metadata.goalBoard ? session.metadata.goalBoard.featurePath === featurePath && session.metadata.goalBoard.taskId === task.id : session.directory === directory;
    const taskHistory = async (task: GoalTask, entry: CatalogRecord, history: ProjectSession[]) => {
        const directory = await safePath(entry.root, dirname(task.indexPath));
        return history.filter(session => belongs(session, task, entry.featurePath, directory));
    };
    const receiptFor = async (directory: string) => readJSON<Receipt>(join(await stateDirectory(directory), 'execution.json'));
    const watchDirectories = async (directories: string[]) => {
        if (!observe) return;
        // Bounded event subscriptions can cover several clients without one client's selection replacing another's.
        for (const directory of directories) {
            try {
                const info = await stat(directory);
                if (disposed) return;
                if (!info.isDirectory()) continue;
                const identity = `${info.dev}:${info.ino}`;
                if (watchers.get(directory)?.identity === identity) continue;
                watchers.get(directory)?.watcher.close(); watchers.delete(directory);
                if (watchers.size >= 400) { const oldest = watchers.keys().next().value!; watchers.get(oldest)?.watcher.close(); watchers.delete(oldest); }
                const watcher = watch(directory, { persistent: false }, () => { if (!disposed) void Promise.resolve(deps.changed()).catch(() => {}); });
                watcher.on('error', () => { watcher.close(); if (watchers.get(directory)?.watcher === watcher) watchers.delete(directory); });
                watchers.set(directory, { watcher, identity });
            } catch { /* Explicit refresh remains available. */ }
        }
    };
    const board = async (featurePath: string) => {
        const entry = await entryFor(featurePath);
        const parsed = await parseBoard(entry, { featureOnly: true, finalOnly: true });
        await watchDirectories(parsed.watchDirectories);
        let history: ProjectSession[] = [];
        let historyAvailable = true;
        try { history = await deps.history(entry.featurePath, parsed.snapshot.tasks.map(task => ({ id: task.id, title: task.title, directory: dirname(task.indexPath) }))); } catch { historyAvailable = false; parsed.snapshot.warnings.push('Session history is unavailable; first execution is disabled until it can be verified.'); }
        for (const task of parsed.snapshot.tasks) {
            const directory = await safePath(entry.root, dirname(task.indexPath));
            const linked = await taskHistory(task, entry, history);
            let receipt = await receiptFor(directory);
            const historical = linked.find(session => session.executed);
            if (!receipt && (historical || ['running', 'review', 'done'].includes(task.status))) {
                // Imported historical execution becomes durable too. Deleting an old
                // conversation or resetting status must never re-enable first injection.
                await claim(join(await stateDirectory(directory), 'execution.json'), { requestId: 'historical', directory, state: 'historical', sessionId: historical?.sessionId, createdAt: Date.now() });
                receipt = await receiptFor(directory);
            }
            task.execution = receipt ? { state: receipt.state === 'starting' ? 'uncertain' : receipt.state, sessionId: receipt.sessionId }
                : { state: !historyAvailable ? 'uncertain' : 'never' };
            for (const artifact of task.artifacts) {
                if (artifact.relation !== 'output' || !artifact.available) continue;
                // Listing only stats files. Original bodies are read on open/explicit acceptance.
                try {
                    if (artifact.path) await safePath(directory, artifact.path);
                    const approval = await readJSON<Approval>(join(await stateDirectory(directory), `approval-${digest(artifact.id)}.json`));
                    artifact.approval = { status: !approval ? 'unreviewed' : approval.revision === artifact.revision ? 'accepted' : 'changed', reviewedAt: approval?.reviewedAt };
                } catch { artifact.approval = { status: 'unreviewed' }; }
            }
        }
        parsed.snapshot.revision = digest(JSON.stringify(parsed.snapshot.tasks));
        // Histories have their own Task-scoped, byte-bounded pagination. Never
        // turn a bounded board snapshot into a multi-megabyte encrypted frame.
        return { success: true as const, snapshot: parsed.snapshot, sessions: {} };
    };
    const historyPage = async (input: unknown) => {
        const cursorSchema = z.object({ updatedAt: z.number(), sessionId: z.string().min(1).max(2048) });
        const data = taskInput.extend({ cursor: cursorSchema.optional() }).parse(input);
        const { entry, task, directory } = await taskFor(data);
        const source = await taskHistory(task, entry, await deps.history(entry.featurePath, [{ id: task.id, title: task.title, directory }]));
        const localDirectory = join(await stateDirectory(directory), 'sessions');
        const names = (await readdir(localDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^[a-f0-9]{24}\.json$/.test(name));
        // Source history normally contains these too; individual association files
        // recover new blank sessions immediately after a response was lost.
        const local = await Promise.all(names.map(name => readJSON<GoalTaskSession>(join(localDirectory, name))));
        const merged = new Map(local.filter((session): session is GoalTaskSession => !!session).map(session => [session.sessionId, session]));
        for (const { metadata: _metadata, ...session } of source) merged.set(session.sessionId, session);
        const ordered = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
        const remaining = data.cursor ? ordered.filter(session => session.updatedAt < data.cursor!.updatedAt || (session.updatedAt === data.cursor!.updatedAt && session.sessionId.localeCompare(data.cursor!.sessionId) < 0)) : ordered;
        const sessions: GoalTaskSession[] = [];
        let bytes = 0;
        for (const session of remaining) {
            const size = Buffer.byteLength(JSON.stringify(session));
            if (sessions.length >= 25 || bytes + size > 64 * 1024) break;
            sessions.push(session); bytes += size;
        }
        const last = sessions.at(-1);
        return { success: true, sessions, ...(last && sessions.length < remaining.length ? { nextCursor: { sessionId: last.sessionId, updatedAt: last.updatedAt } } : {}) };
    };
    const launch = async (input: unknown): Promise<SpawnSessionResult> => {
        const data = launchInput.parse(input);
        const { entry, task, directory } = await taskFor(data);
        const state = await stateDirectory(directory);
        // Repeated requests join the same operation. Cross-process/restart claims fail closed below.
        const operationKey = JSON.stringify([directory, data.action === 'execute' ? 'execute' : data.requestId]);
        const pending = inFlight.get(operationKey);
        if (pending) return pending;
        const operation = (async (): Promise<SpawnSessionResult> => {
            const file = join(state, data.action === 'execute' ? 'execution.json' : `chat-${digest(data.requestId)}.json`);
            if (data.action === 'execute') {
                const historical = await taskHistory(task, entry, await deps.history(entry.featurePath, [{ id: task.id, title: task.title, directory }]));
                const prior = historical.find(session => session.executed);
                if (prior || ['running', 'review', 'done'].includes(task.status)) {
                    await claim(file, { requestId: 'historical', directory, state: 'historical', sessionId: prior?.sessionId, createdAt: Date.now() });
                    return { type: 'error', errorMessage: 'This task already has execution history. Open a conversation to continue.' };
                }
            }
            const receipt: Receipt = { requestId: data.requestId, directory, state: 'starting', createdAt: Date.now() };
            if (!await claim(file, receipt)) {
                const previous = await readJSON<Receipt>(file);
                if (previous?.sessionId) return { type: 'success', sessionId: previous.sessionId };
                return { type: 'error', errorMessage: 'The previous launch outcome is unknown. It will not be submitted again.' };
            }
            try {
                const spawned = await deps.spawn({ directory, agent: data.agent, approvedNewDirectoryCreation: false,
                    ...(data.agent === 'codex' ? { model: data.model, effort: data.effort, codexSessionGrant: data.codexSessionGrant } : {}) });
                if (spawned.type !== 'success') {
                    // Even a startup timeout can leave a live child. Keep the durable claim until explicitly reconciled.
                    receipt.state = 'uncertain'; await saveJSON(file, receipt); return spawned;
                }
                receipt.sessionId = spawned.sessionId;
                const sessionsDirectory = join(state, 'sessions');
                await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
                // One atomic association per session avoids lost updates across clients or processes.
                await saveJSON(join(sessionsDirectory, `${digest(spawned.sessionId)}.json`), { sessionId: spawned.sessionId, title: task.title, directory, updatedAt: Date.now(), executed: data.action === 'execute' });
                receipt.state = data.action === 'execute' ? 'uncertain' : 'submitted';
                await saveJSON(file, receipt);
                if (data.action === 'execute') {
                    await deps.send(spawned.sessionId, goalBoardTaskPrompt(task, entry.featurePath), `goal-first:${digest(directory)}`);
                    receipt.state = 'submitted'; await saveJSON(file, receipt);
                }
                return spawned;
            } catch (error) {
                receipt.state = 'uncertain'; await saveJSON(file, receipt);
                return { type: 'error', errorMessage: `Launch outcome is uncertain; no automatic resubmission. ${error instanceof Error ? error.message : 'Launch failed'}` };
            } finally { await deps.changed(); }
        })();
        inFlight.set(operationKey, operation);
        try { return await operation; } finally { inFlight.delete(operationKey); }
    };
    const files = async (input: unknown, operation: 'list' | 'read' | 'write', scope = false, featureReadOnly = false) => {
        const data = taskInput.extend({ taskId: z.string().min(1).max(2048).optional() }).extend({ path: pathInput, content: z.string().max(3 * 1024 * 1024).optional(), expectedHash: z.string().optional(), offset: z.number().int().nonnegative().optional(), revision: z.string().max(200).optional(), transferId: z.string().uuid().optional() }).parse(input);
        if (featureReadOnly && (operation === 'write' || data.taskId)) throw new Error('Goal overview is read-only');
        let directory: string, root: string;
        const transfer = operation === 'read' && data.transferId ? transfers.get(data.transferId) : undefined;
        if (data.transferId) {
            if (disposed || !transfer || transfer.expiresAt < Date.now() || transfer.scope !== scope || transfer.featureReadOnly !== featureReadOnly || transfer.featurePath !== data.featurePath || transfer.taskId !== data.taskId || transfer.path !== data.path || transfer.revision !== data.revision) throw new Error('File transfer expired or changed; reopen it');
            directory = transfer.directory; root = transfer.root;
            if (await safePath(root, directory) !== directory) throw new Error('Task directory changed during transfer');
        } else {
            if ((data.offset ?? 0) !== 0) throw new Error('Start a file transfer at offset zero');
            if (featureReadOnly) { const entry = await entryFor(data.featurePath); directory = entry.featurePath; root = entry.root; }
            else if (scope) { const selected = await scopeFor(data.featurePath); directory = selected.directory; root = selected.root; }
            else { const selected = await taskFor(data); directory = selected.directory; root = selected.entry.root; }
        }
        const path = await safePath(directory, data.path);
        if (!within(directory, path)) throw new Error('File is outside this Task archive');
        const { createWorkspaceFileHandlers } = await import('../common/workspaceFiles');
        const handlers = createWorkspaceFileHandlers(directory, deps.getArtifactStore);
        if (operation === 'list') { await watchDirectories([path]); return handlers.list({ path }); }
        if (operation === 'write') {
            const result = await handlers.write({ path, content: data.content!, expectedHash: data.expectedHash });
            if (result.success) { await deps.changed(); return { ...result, revision: goalFileRevision(await stat(path)) }; }
            return result;
        }
        // Transfer bounded chunks over encrypted RPC; never exceed the relay's frame limit.
        const source = await openAuthorizedFile(directory, path, 50 * 1024 * 1024);
        try {
            const revision = goalFileRevision(source.info);
            if (data.revision && data.revision !== revision) throw new Error('File changed during transfer; reopen it');
            const offset = data.offset ?? 0;
            if (offset > source.info.size) throw new Error('Invalid file offset');
            const bytes = Buffer.alloc(Math.min(64 * 1024, source.info.size - offset));
            const { bytesRead } = await source.handle.read(bytes, 0, bytes.length, offset);
            const after = await source.handle.stat();
            if (after.size !== source.info.size || after.mtimeMs !== source.info.mtimeMs || after.ctimeMs !== source.info.ctimeMs) throw new Error('File changed during transfer; reopen it');
            const transferId = data.transferId ?? randomUUID();
            if (offset + bytesRead < source.info.size) {
                for (const [id, value] of transfers) if (value.expiresAt < Date.now()) transfers.delete(id);
                if (!data.transferId && transfers.size >= 128) throw new Error('Too many active archive file transfers');
                transfers.set(transferId, { scope, featureReadOnly, featurePath: data.featurePath, taskId: data.taskId, directory, root, path: data.path, revision, expiresAt: Date.now() + 60000 });
            } else transfers.delete(transferId);
            return { success: true, content: bytes.subarray(0, bytesRead).toString('base64'), size: source.info.size, revision, offset, transferId };
        } finally { await source.handle.close(); }
    };
    const approvalLocks = new Map<string, Promise<unknown>>();
    const approve = async (input: unknown) => {
        const data = taskInput.extend({ artifactId: z.string().max(2048), expectedRevision: z.string().regex(/^[a-f0-9]{24}$/), expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(input);
        const { task, directory } = await taskFor(data);
        const artifact = task.artifacts.find(artifact => artifact.id === data.artifactId && artifact.relation === 'output');
        if (!artifact?.available || (!artifact.path && !artifact.url)) throw new Error('Final deliverable is unavailable');
        const path = artifact.path ? await safePath(directory, artifact.path) : null;
        const file = join(await stateDirectory(directory), `approval-${digest(artifact.id)}.json`);
        const previous = approvalLocks.get(file) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(async () => {
            let hash: string;
            if (path) {
                const bytes = await readBoundedFile(directory, path, 50 * 1024 * 1024);
                hash = sha256(bytes);
                if (!data.expectedHash || hash !== data.expectedHash || goalFileRevision(await stat(path)) !== data.expectedRevision) throw new Error('The deliverable changed. Read the latest version before accepting.');
            } else {
                // External links are explicitly accepted as links, not immutable local bytes.
                if (digest(artifact.url!) !== data.expectedRevision) throw new Error('The deliverable link changed. Open it again before accepting.');
                hash = sha256(Buffer.from(artifact.url!));
            }
            await saveJSON(file, { revision: data.expectedRevision, hash, reviewedAt: Date.now() }); await deps.changed(); return { success: true };
        });
        approvalLocks.set(file, pending);
        try { return await pending; } finally { if (approvalLocks.get(file) === pending) approvalLocks.delete(file); }
    };
    return {
        projects: async () => {
            const roots = await discoverRoots(deps.workingDirectory, deps.homeDirectory);
            await watchDirectories(roots);
            for (const root of roots) {
                for (const name of (await readdir(root)).sort().slice(0, 100)) {
                    try {
                        const project = await safePath(root, join(root, name));
                        if (!(await stat(project)).isDirectory()) continue;
                        await watchDirectories([project]);
                        const features = await safePath(root, join(project, 'features'));
                        await watchDirectories([features]);
                        for (const feature of (await readdir(features)).slice(0, 100)) {
                            const path = await safePath(root, join(features, feature));
                            if ((await stat(path)).isDirectory()) await watchDirectories([path]);
                        }
                    } catch { /* A partially created archive is observed by its nearest directory. */ }
                }
            }
            return { success: true, projects: await readProjects(roots) };
        },
        board, launch, files, approve, historyPage, overview, scopeHistory,
        author: async (input: unknown): Promise<SpawnSessionResult> => {
            const data = z.object({ scopePath: pathInput.optional(), requestId: z.string().min(1).max(128), agent: z.enum(['codex', 'claude']), codexSessionGrant: z.string().max(4096).optional() }).parse(input);
            const roots = await discoverRoots(deps.workingDirectory, deps.homeDirectory);
            const projects = await readProjects(roots);
            const allowed = [...roots, ...projects.flatMap(project => [project.projectPath, ...project.features.map(feature => feature.featurePath)])];
            const directory = data.scopePath ? await realpath(data.scopePath) : roots[0];
            if (!directory || !allowed.includes(directory)) throw new Error('Choose an installed Goal First project archive');
            const file = join(await stateDirectory(directory), `author-${digest(data.requestId)}.json`);
            if (!await claim(file, { requestId: data.requestId })) {
                const receipt = await readJSON<{ sessionId?: string }>(file);
                return receipt?.sessionId ? { type: 'success', sessionId: receipt.sessionId } : { type: 'error', errorMessage: 'The conversation launch outcome is unknown.' };
            }
            const result = await deps.spawn({ directory, agent: data.agent, codexSessionGrant: data.codexSessionGrant, approvedNewDirectoryCreation: false });
            if (result.type === 'success') await saveJSON(file, { requestId: data.requestId, sessionId: result.sessionId });
            return result;
        },
        dispose() { disposed = true; for (const { watcher } of watchers.values()) watcher.close(); watchers.clear(); transfers.clear(); },
    };
}

export function registerProjectGoalHandlers(manager: { registerHandler(method: string, handler: (input: any) => Promise<any>): void }, deps: ProjectGoalDependencies) {
    const service = createProjectGoalService(deps);
    const wrap = (handler: (input: any) => Promise<any>) => async (input: unknown) => {
        try { return await handler(input); } catch (error) { return { success: false, error: (error instanceof Error ? error.message : 'Project request failed').slice(0, 2048) }; }
    };
    manager.registerHandler('goalScopeRead', wrap(service.overview));
    manager.registerHandler('goalScopeHistory', wrap(service.scopeHistory));
    manager.registerHandler('goalScopeListDirectory', wrap(input => service.files(input, 'list', true)));
    manager.registerHandler('goalScopeReadFile', wrap(input => service.files(input, 'read', true)));
    manager.registerHandler('goalScopeWriteFile', wrap(input => service.files(input, 'write', true)));
    manager.registerHandler('goalProjects', wrap(service.projects));
    manager.registerHandler('goalProjectRead', wrap(input => service.board(input?.featurePath)));
    manager.registerHandler('goalTaskHistory', wrap(service.historyPage));
    manager.registerHandler('goalTaskLaunch', wrap(service.launch));
    manager.registerHandler('goalProjectAuthor', wrap(service.author));
    manager.registerHandler('goalTaskListDirectory', wrap(input => service.files(input, 'list')));
    manager.registerHandler('goalTaskReadFile', wrap(input => service.files(input, 'read')));
    manager.registerHandler('goalFeatureListDirectory', wrap(input => service.files(input, 'list', true, true)));
    manager.registerHandler('goalFeatureReadFile', wrap(input => service.files(input, 'read', true, true)));
    manager.registerHandler('goalTaskWriteFile', wrap(input => service.files(input, 'write')));
    manager.registerHandler('goalTaskApprove', wrap(service.approve));
    return service;
}
