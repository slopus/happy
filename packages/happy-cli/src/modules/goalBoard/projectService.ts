import { createTaskIdentityStore, isStableTaskId } from './taskIdentity';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readdir, rename, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { goalOutputRecognition, GoalProjectConversationCandidateSchema } from '@slopus/happy-wire';
import type { GoalTask, GoalTaskSession, GoalProjectConversation, GoalProjectConversationGroup, GoalProjectConversationCandidate, GoalProjectConversationCatalogPage, GoalProjectConversationCatalogManifestPage } from '@slopus/happy-wire';
import { discoverRoots, readCatalog, readProjects, safePath, within, catalogSummary, MAX_CATALOG, type CatalogRecord } from './catalog';
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
    history: (featurePath: string, tasks: Array<{ id: string; directory: string; title?: string; directories?: string[]; sessionIds?: string[]; featurePath?: string }>, options?: { headersOnly: true; headerCandidates?: GoalProjectConversationCandidate[]; catalogFingerprint?: string; snapshotId?: string }) => Promise<ProjectSession[]>;
    disposeConversationCatalog?: () => void;
    conversationCatalog?: (projectPath: string, input: { snapshotId?: string; cursor?: string; format?: 'manifest'; sessionIds?: string[] }) => Promise<GoalProjectConversationCatalogPage | GoalProjectConversationCatalogManifestPage>;
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
const archived = (state?: string) => state === 'archived' || state === 'archiveRequested';
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
    const identities = createTaskIdentityStore(deps.storageDirectory);
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
        const sessions = source.filter(session => !archived(session.metadata.lifecycleState) && session.directory === directory && (!session.metadata.goalBoard || (!session.metadata.goalBoard.taskId && session.metadata.goalBoard.featurePath === directory)))
            .sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId))
            .slice(0, 25).map(({ metadata, ...session }) => ({ ...session, lifecycleState: metadata.lifecycleState }));
        return { success: true, sessions };
    };
    const identityCatalog = async (strictProjectPath?: string) => {
        const result: Array<{ entry: CatalogRecord; task: GoalTask }> = [];
        const duplicateIds = new Set<string>();
        const entries = await catalog();
        if (strictProjectPath) {
            if (entries.length >= MAX_CATALOG) throw new Error('Project catalog limit reached; complete conversation totals are unavailable');
            for (const root of await discoverRoots(deps.workingDirectory, deps.homeDirectory)) {
                if ((await readdir(root)).length > MAX_CATALOG) throw new Error('Project directory limit reached; complete conversation totals are unavailable');
            }
            for (const projectPath of new Set(entries.map(entry => entry.projectPath!))) {
                const features = await readdir(join(projectPath, 'features')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
                if (features.length > MAX_CATALOG) throw new Error('Feature directory limit reached; complete conversation totals are unavailable');
            }
        }
        for (const entry of entries) {
            const { snapshot } = await parseBoard(entry, { featureOnly: true, finalOnly: true, ...(strictProjectPath ? { strictCompleteness: true } : {}) });
            if (strictProjectPath && snapshot.warnings.some(warning => /truncat|limit reached|budget exceeded/i.test(warning)
                || (entry.projectPath === strictProjectPath && /Unavailable (task entry|navigation)/i.test(warning))))
                throw new Error('Task catalog is incomplete; complete conversation totals are unavailable');
            for (const id of snapshot.ambiguousTaskIds ?? []) duplicateIds.add(id);
            for (const task of snapshot.tasks) result.push({ entry, task });
        }
        const stableIds = result.filter(({ task }) => isStableTaskId(task.id)).map(({ task }) => task.id);
        for (const id of stableIds.filter((id, i) => stableIds.indexOf(id) !== i)) duplicateIds.add(id);
        const unique = result.filter(({ task }) => !duplicateIds.has(task.id));
        for (const { task } of unique) await identities.remember(task);
        return unique;
    };
    const resolveWorkspace = async (input: unknown) => {
        const data = z.object({ sessionId: z.string().min(1).max(2048), path: pathInput,
            goalBoard: z.object({ featurePath: pathInput, taskId: z.string().max(2048).optional() }).optional() }).parse(input);
        const entries = await identityCatalog();
        const bound = await identities.session(data.sessionId);
        const explicit = data.goalBoard?.taskId;
        if (bound && explicit && isStableTaskId(explicit) && bound !== explicit) return { success: true as const, workspace: null };
        const stable = bound ?? (explicit && isStableTaskId(explicit) ? explicit : undefined);
        const actual = await realpath(data.path).catch(() => data.path);
        const matches = [];
        for (const item of entries) {
            const { task, entry } = item;
            if (stable) { if (task.id === stable) matches.push(item); continue; }
            const aliases = new Set(isStableTaskId(task.id) ? await identities.paths(task.id) : [dirname(task.indexPath)]);
            if (explicit) {
                // Old clients used a digest of indexPath. Match only this exact observed identity.
                if ([...aliases].some(path => digest(join(path, 'index.md')) === explicit) ||
                    (entry.featurePath === data.goalBoard?.featurePath && task.id === explicit)) matches.push(item);
                // A compatibility symlink can establish the former path digest without guessing its title.
                else if (aliases.has(actual) && digest(join(data.path, 'index.md')) === explicit) matches.push(item);
            } else if (!data.goalBoard && (aliases.has(actual) || aliases.has(data.path))) matches.push(item);
        }
        if (matches.length !== 1) return { success: true as const, workspace: null };
        const { entry, task } = matches[0];
        if (actual === dirname(task.indexPath)) await identities.remember(task, data.path);
        await identities.bind(data.sessionId, task.id);
        return { success: true as const, workspace: { projectPath: entry.projectPath!, featurePath: entry.featurePath,
            taskId: task.id, directory: dirname(task.indexPath) } };
    };
    const taskFor = async (input: unknown) => {
        const data = taskInput.parse(input);
        let selected: { entry: CatalogRecord; task: GoalTask } | undefined;
        if (isStableTaskId(data.taskId)) selected = (await identityCatalog()).find(item => item.task.id === data.taskId);
        else {
            const entry = await entryFor(data.featurePath);
            const parsed = await parseBoard(entry, { featureOnly: true, finalOnly: true });
            const legacy = parsed.snapshot.tasks.find(task => !isStableTaskId(task.id) && task.id === data.taskId);
            if (legacy) {
                if (await identities.hasPathHistory(dirname(legacy.indexPath))) throw new Error('This path belonged to another task; assign the new archive its own task_id');
                selected = { entry, task: legacy };
            }
            else {
                // Old hash inputs get exactly the same ambiguity checks as session navigation.
                const matches = [];
                for (const item of await identityCatalog()) {
                    if (item.entry.featurePath !== entry.featurePath) continue;
                    if ((await identities.paths(item.task.id)).some(path => digest(join(path, 'index.md')) === data.taskId)) matches.push(item);
                }
                if (matches.length === 1) selected = matches[0];
            }
        }
        if (!selected) throw new Error('Task is not in this feature or its identity is unavailable or ambiguous');
        const { entry, task } = selected;
        await identities.remember(task);
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
    const historyTask = async (task: GoalTask) => ({ id: task.id, title: task.title, directory: dirname(task.indexPath), directories: isStableTaskId(task.id) ? await identities.paths(task.id) : [dirname(task.indexPath)], sessionIds: await identities.sessions(task.id) });
    const taskHistory = async (task: GoalTask, entry: CatalogRecord, history: ProjectSession[]) => {
        const directory = await safePath(entry.root, dirname(task.indexPath));
        const paths = isStableTaskId(task.id) ? await identities.paths(task.id) : [directory];
        const matches = await Promise.all(history.map(async session => {
            const binding = session.metadata.goalBoard;
            const bound = await identities.session(session.sessionId);
            if (bound) return bound === task.id && (!binding?.taskId || !isStableTaskId(binding.taskId) || binding.taskId === bound);
            if (!binding) return paths.includes(session.directory);
            if (isStableTaskId(task.id) && binding.taskId === task.id) return true;
            return (binding.featurePath === entry.featurePath && binding.taskId === task.id) || paths.some(path => digest(join(path, 'index.md')) === binding.taskId);
        }));
        return history.filter((_, index) => matches[index]).map(session => ({ ...session, directory }));
    };
    const receiptFor = async (task: GoalTask) => readJSON<Receipt>(join(await identities.state(task), 'execution.json'));
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
        if (parsed.snapshot.tasks.some(task => isStableTaskId(task.id))) {
            const unique = new Set((await identityCatalog()).map(({ task }) => task.id));
            parsed.snapshot.tasks = parsed.snapshot.tasks.filter(task => {
                if (unique.has(task.id)) return true;
                parsed.snapshot.warnings.push(`Ambiguous task identity: ${task.id}`); return false;
            });
        }
        let history: ProjectSession[] = [];
        let historyAvailable = true;
        try { history = await deps.history(entry.featurePath, await Promise.all(parsed.snapshot.tasks.map(historyTask))); } catch { historyAvailable = false; parsed.snapshot.warnings.push('Session history is unavailable; first execution is disabled until it can be verified.'); }
        for (const task of parsed.snapshot.tasks) {
            await identities.remember(task);
            if (isStableTaskId(task.id)) task.legacyIds = (await identities.paths(task.id)).map(path => digest(join(path, 'index.md'))).slice(0, 32);
            const directory = await safePath(entry.root, dirname(task.indexPath));
            const linked = await taskHistory(task, entry, history);
            let receipt = await receiptFor(task);
            const historical = linked.find(session => session.executed);
            if (!receipt && (historical || ['running', 'review', 'done'].includes(task.status))) {
                // Imported historical execution becomes durable too. Deleting an old
                // conversation or resetting status must never re-enable first injection.
                await claim(join(await identities.state(task), 'execution.json'), { requestId: 'historical', directory, state: 'historical', sessionId: historical?.sessionId, createdAt: Date.now() });
                receipt = await receiptFor(task);
            }
            task.execution = receipt ? { state: receipt.state === 'starting' ? 'uncertain' : receipt.state, sessionId: receipt.sessionId }
                : { state: !historyAvailable ? 'uncertain' : 'never' };
            for (const artifact of task.artifacts) {
                if (artifact.relation !== 'output' || !artifact.available) continue;
                // Listing only stats files. Original bodies are read on open/explicit acceptance.
                try {
                    if (artifact.path) await safePath(directory, artifact.path);
                    const approval = await readJSON<Approval>(join(await identities.state(task), `approval-${digest(artifact.id)}.json`));
                    artifact.approval = { status: goalOutputRecognition(task, artifact) ? 'accepted' : !approval ? 'unreviewed' : approval.revision === artifact.revision ? 'accepted' : 'changed', reviewedAt: approval?.reviewedAt };
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
        const source = await taskHistory(task, entry, await deps.history(entry.featurePath, [await historyTask(task)]));
        const localDirectory = join(await identities.state(task), 'sessions');
        const names = (await readdir(localDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; })).filter(name => /^[a-f0-9]{24}\.json$/.test(name));
        // Source history normally contains these too; individual association files
        // recover new blank sessions immediately after a response was lost.
        const local = await Promise.all(names.map(name => readJSON<GoalTaskSession>(join(localDirectory, name))));
        const merged = new Map(local.filter((session): session is GoalTaskSession => !!session).map(session => [session.sessionId, session]));
        for (const { metadata, ...session } of source) merged.set(session.sessionId, { ...session, lifecycleState: metadata.lifecycleState });
        const ordered = [...merged.values()].map(session => ({ ...session, directory })).filter(session => !archived(session.lifecycleState)).sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
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
    const conversationCatalog = async (input: unknown) => {
        if (disposed) throw new Error('Project workspace is closed');
        const data = z.object({ projectPath: pathInput, snapshotId: z.string().min(1).max(128).optional(), cursor: z.string().max(32).optional(),
            format: z.literal('manifest').optional(),
            sessionIds: z.array(z.string().min(1).max(2048)).max(200).optional().transform(ids => ids === undefined ? undefined : [...new Set(ids)]),
        }).parse(input);
        if (data.sessionIds !== undefined && (!data.snapshotId || data.format === 'manifest'))
            throw new Error('Ciphertext session selection requires its snapshot and cannot use manifest format');
        const projectPath = await realpath(data.projectPath);
        const projects = await readProjects(await discoverRoots(deps.workingDirectory, deps.homeDirectory));
        if (!projects.some(project => project.projectPath === projectPath)) throw new Error('Project is outside the authorized Goal catalog');
        if (!deps.conversationCatalog) throw new Error('Conversation catalog snapshots are unavailable; update this machine CLI');
        return deps.conversationCatalog(projectPath, { snapshotId: data.snapshotId, cursor: data.cursor, format: data.format, sessionIds: data.sessionIds });
    };
    const conversations = async (input: unknown) => {
        if (disposed) throw new Error('Project workspace is closed');
        const cursorSchema = z.object({ updatedAt: z.number(), sessionId: z.string().min(1).max(2048) });
        if (Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) throw new Error('Conversation candidate request exceeds the byte limit');
        const data = z.object({ projectPath: pathInput, scopePath: pathInput.optional(), cursor: cursorSchema.optional(),
            candidates: z.array(GoalProjectConversationCandidateSchema).max(20000).optional(),
            catalogFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(), catalogSnapshotId: z.string().min(1).max(128).optional(),
        }).refine(value => value.candidates === undefined || !!value.catalogFingerprint, 'A complete candidate catalog fingerprint is required')
            .refine(value => !value.catalogSnapshotId || value.candidates !== undefined, 'A conversation snapshot requires complete owner candidates').parse(input);
        if (data.cursor && !data.scopePath) throw new Error('Choose a conversation group for pagination');
        const projectPath = await realpath(data.projectPath);
        const projects = await readProjects(await discoverRoots(deps.workingDirectory, deps.homeDirectory));
        const project = projects.find(project => project.projectPath === projectPath);
        if (!project) throw new Error('Project is outside the authorized Goal catalog');
        const scopes = [{ scopePath: projectPath, title: project.title }, ...project.features.map(feature => ({ scopePath: feature.featurePath, title: feature.title }))];
        const requestedScope = data.scopePath ? await realpath(data.scopePath) : undefined;
        if (requestedScope && !scopes.some(scope => scope.scopePath === requestedScope)) throw new Error('Conversation group is outside this project');
        // One identity catalog and one finite account-header traversal per read,
        // never one complete account scan for every feature or Task.
        const allTasks = await identityCatalog(projectPath);
        const tasks = [];
        for (const item of allTasks.filter(item => item.entry.projectPath === projectPath)) {
            const directory = dirname(item.task.indexPath);
            if (!isStableTaskId(item.task.id) && await identities.hasPathHistory(directory)) continue;
            await identities.remember(item.task);
            tasks.push({ ...item, descriptor: { ...await historyTask(item.task), featurePath: item.entry.featurePath } });
        }
        const descriptors = [...scopes.map(scope => ({ id: '', directory: scope.scopePath, title: scope.title, featurePath: scope.scopePath })), ...tasks.map(item => item.descriptor)];
        const source = await deps.history(projectPath, descriptors, { headersOnly: true, ...(data.candidates ? { headerCandidates: data.candidates, catalogFingerprint: data.catalogFingerprint, ...(data.catalogSnapshotId ? { snapshotId: data.catalogSnapshotId } : {}) } : {}) });
        const grouped = new Map(scopes.map(scope => [scope.scopePath, new Map<string, GoalProjectConversation>()]));
        for (const session of source) {
            if (archived(session.metadata.lifecycleState)) continue;
            const binding = session.metadata.goalBoard;
            const bound = await identities.session(session.sessionId);
            const explicit = binding?.taskId;
            let task: typeof tasks[number] | undefined;
            if (bound || (explicit && isStableTaskId(explicit))) {
                if (bound && explicit && isStableTaskId(explicit) && bound !== explicit) continue;
                task = tasks.find(item => item.task.id === (bound ?? explicit));
                if (!task) continue; // Missing or ambiguous identity never falls back to cwd.
            } else if (explicit) {
                const matches = tasks.filter(item => (item.entry.featurePath === binding?.featurePath && item.task.id === explicit)
                    || item.descriptor.directories.some(directory => digest(join(directory, 'index.md')) === explicit));
                if (matches.length !== 1) continue;
                task = matches[0];
            } else if (!binding) {
                const matches = tasks.filter(item => item.descriptor.sessionIds.includes(session.sessionId)
                    || item.descriptor.directories.some(directory => directory === session.directory || directory === session.metadata.path));
                if (matches.length > 1) continue;
                task = matches[0];
            }
            const scopePath = task?.entry.featurePath ?? (binding ? binding.featurePath : session.directory);
            if (!task && session.directory !== scopePath) continue;
            const group = grouped.get(scopePath);
            if (!group) continue;
            const { metadata: _, ...header } = session;
            group.set(session.sessionId, { ...header, lifecycleState: session.metadata.lifecycleState, title: header.title.slice(0, 2048), directory: task ? dirname(task.task.indexPath) : scopePath, ...(task ? { taskId: task.task.id } : {}) });
        }
        const groups: GoalProjectConversationGroup[] = [];
        // Reserve catalog headers before filling rows: encrypted RPC frames stay
        // bounded even when a project has many feature groups or long paths.
        const selectedScopes = scopes.filter(scope => !requestedScope || scope.scopePath === requestedScope);
        let bytes = Buffer.byteLength(JSON.stringify(selectedScopes.map(scope => ({ ...scope, total: 0, sessions: [] }))));
        if (bytes > 192 * 1024) throw new Error('Conversation group catalog is too large');
        for (const scope of selectedScopes) {
            const ordered = [...grouped.get(scope.scopePath)!.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
            const remaining = data.cursor ? ordered.filter(session => session.updatedAt < data.cursor!.updatedAt
                || (session.updatedAt === data.cursor!.updatedAt && session.sessionId.localeCompare(data.cursor!.sessionId) < 0)) : ordered;
            const sessions: GoalProjectConversation[] = [];
            let pageBytes = 0;
            for (const session of remaining) {
                const size = Buffer.byteLength(JSON.stringify(session));
                if (sessions.length >= 25 || pageBytes + size > 64 * 1024 || bytes + size > 256 * 1024) break;
                sessions.push(session); pageBytes += size; bytes += size;
            }
            const last = sessions.at(-1);
            groups.push({ ...scope, total: ordered.length, sessions, ...(sessions.length < remaining.length
                ? { nextCursor: last ? { updatedAt: last.updatedAt, sessionId: last.sessionId } : { updatedAt: Number.MAX_VALUE, sessionId: 'start' } } : {}) });
        }
        return { success: true as const, projectPath, groups };
    };
    const launch = async (input: unknown): Promise<SpawnSessionResult> => {
        const data = launchInput.parse(input);
        let { entry, task, directory } = await taskFor(data);
        if (!isStableTaskId(task.id)) {
            // A user-triggered launch upgrades legacy archives once. Ordinary reads never edit them.
            const source = await readBoundedFile(directory, task.indexPath, 256 * 1024);
            const text = source.toString('utf8');
            if (/^task_id:/m.test(text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '')) throw new Error('Task archive has an invalid task_id');
            const taskId = await identities.allocate(task.indexPath, sha256(source));
            const content = /^---\r?\n/.test(text) ? text.replace(/^(---\r?\n)/, `$1task_id: ${taskId}\n`) : `---\ntask_id: ${taskId}\n---\n${text}`;
            const { createWorkspaceFileHandlers } = await import('../common/workspaceFiles');
            const saved = await createWorkspaceFileHandlers(directory).write({ path: task.indexPath, content: Buffer.from(content).toString('base64'), expectedHash: sha256(source) });
            if (saved.success) ({ entry, task, directory } = await taskFor({ featurePath: entry.featurePath, taskId }));
            else {
                // Another launcher may have won the same compare-and-write. Join its identity.
                ({ entry, task, directory } = await taskFor(data));
                if (!isStableTaskId(task.id)) throw new Error('Task changed while assigning its identity; reopen it');
            }
        }
        const state = await identities.state(task);
        // Repeated requests join the same operation. Cross-process/restart claims fail closed below.
        const operationKey = JSON.stringify([directory, data.action === 'execute' ? 'execute' : data.requestId]);
        const pending = inFlight.get(operationKey);
        if (pending) return pending;
        const operation = (async (): Promise<SpawnSessionResult> => {
            const file = join(state, data.action === 'execute' ? 'execution.json' : `chat-${digest(data.requestId)}.json`);
            if (data.action === 'execute') {
                const historical = await taskHistory(task, entry, await deps.history(entry.featurePath, [await historyTask(task)]));
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
                await identities.bind(spawned.sessionId, task.id);
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
        const file = join(await identities.state(task), `approval-${digest(artifact.id)}.json`);
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
        board, launch, files, approve, historyPage, overview, scopeHistory, conversations, conversationCatalog, resolveWorkspace,
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
        dispose() { disposed = true; deps.disposeConversationCatalog?.(); for (const { watcher } of watchers.values()) watcher.close(); watchers.clear(); transfers.clear(); },
    };
}

export function registerProjectGoalHandlers(manager: { registerHandler(method: string, handler: (input: any) => Promise<any>): void }, deps: ProjectGoalDependencies) {
    const service = createProjectGoalService(deps);
    const wrap = (handler: (input: any) => Promise<any>) => async (input: unknown) => {
        try { return await handler(input); } catch (error) { return { success: false, error: (error instanceof Error ? error.message : 'Project request failed').slice(0, 2048) }; }
    };
    manager.registerHandler('goalScopeRead', wrap(service.overview));
    manager.registerHandler('goalScopeHistory', wrap(service.scopeHistory));
    manager.registerHandler('goalProjectConversations', wrap(service.conversations));
    manager.registerHandler('goalProjectConversationCatalog', wrap(service.conversationCatalog));
    manager.registerHandler('goalScopeListDirectory', wrap(input => service.files(input, 'list', true)));
    manager.registerHandler('goalScopeReadFile', wrap(input => service.files(input, 'read', true)));
    manager.registerHandler('goalScopeWriteFile', wrap(input => service.files(input, 'write', true)));
    manager.registerHandler('goalResolveWorkspace', wrap(service.resolveWorkspace));
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
