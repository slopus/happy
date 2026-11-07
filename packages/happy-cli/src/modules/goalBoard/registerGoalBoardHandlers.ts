import { watch, type FSWatcher } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import type { GoalArtifact, GoalBoardAttachment, GoalBoardSnapshot, GoalTask } from '@slopus/happy-wire';
import { GOAL_ARTIFACT_MAX_INLINE_TEXT_BYTES, GOAL_ARTIFACT_MAX_TEXT_BYTES } from '@slopus/happy-wire';
import { discoverRoots, readCatalog, safePath, type CatalogRecord } from './catalog';
import { digest, parseBoard, readBoundedFile } from './parser';
import { withStagedAttachment } from './authorizedFiles';

type Manager = {
    registerHandler: (method: string, handler: (request: any) => Promise<any>) => void;
    unregisterHandler: (method: string) => void;
};
export type GoalBoardOptions = {
    homeDirectory?: string;
    initialFeaturePath?: string;
    onSnapshot: (snapshot: GoalBoardSnapshot) => void | Promise<void>;
    prepareAttachment: (path: string, kind: GoalArtifact['kind']) => Promise<GoalBoardAttachment>;
    startTask?: (task: GoalTask, featurePath: string, requestId: string) => Promise<{ success: boolean; sessionId?: string; title?: string; error?: string }>;
};

/** Owns one selected feature and its event-driven watcher for the session lifetime. */
export function registerGoalBoardHandlers(manager: Manager, workingDirectory: string, options: GoalBoardOptions): { dispose(): void } {
    let disposed = false;
    let generation = 0;
    let active: CatalogRecord | null = null;
    let snapshot: GoalBoardSnapshot | null = null;
    let publishedRevision: string | null = null;
    let refreshing = false;
    let invalidated = false;
    const watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
    const attachments = new Map<string, Promise<GoalBoardAttachment>>();
    // Session-owned first snapshots survive explicit rereads/feature switches. Never evict an
    // accepted ID: rebuilding its payload could reject a retry after a child already spawned.
    const taskLaunches = new Map<string, { featurePath: string; task: GoalTask }>();
    const current = (epoch: number) => !disposed && generation === epoch;
    const assertCurrent = (epoch: number) => { if (!current(epoch)) throw new Error('Goal selection changed or session closed'); };
    const closeWatchers = () => { for (const { watcher } of watchers.values()) watcher.close(); watchers.clear(); };
    const watchDirectories = async (directories: string[], epoch: number) => {
        if (!current(epoch)) return;
        const desired = new Set(directories);
        for (const [directory, existing] of watchers) {
            if (!desired.has(directory)) { existing.watcher.close(); watchers.delete(directory); }
        }
        for (const directory of directories) {
            try {
                const info = await stat(directory);
                if (!current(epoch)) return;
                const identity = `${info.dev}:${info.ino}`;
                const existing = watchers.get(directory);
                if (existing?.identity === identity) continue;
                existing?.watcher.close();
                watchers.delete(directory);
                const watcher = watch(directory, { persistent: false }, () => { if (current(epoch)) { invalidated = true; void refresh(epoch); } });
                watcher.on('error', () => { watcher.close(); if (watchers.get(directory)?.watcher === watcher) watchers.delete(directory); });
                watchers.set(directory, { watcher, identity });
            } catch {
                watchers.get(directory)?.watcher.close();
                watchers.delete(directory);
            }
        }
    };
    const publish = async (next: GoalBoardSnapshot, epoch: number) => {
        assertCurrent(epoch);
        if (publishedRevision === next.revision) return;
        await options.onSnapshot(next);
        assertCurrent(epoch);
        publishedRevision = next.revision;
    };
    const refresh = async (epoch: number): Promise<void> => {
        if (refreshing || !current(epoch) || !active) return;
        refreshing = true;
        try {
            // Re-read only when a real filesystem event arrived while a read was in flight.
            do {
                invalidated = false;
                const parsed = await parseBoard(active);
                if (!current(epoch)) return;
                await watchDirectories(parsed.watchDirectories, epoch);
                if (!current(epoch)) return;
                snapshot = parsed.snapshot;
                await publish(parsed.snapshot, epoch);
            } while (invalidated && current(epoch));
        } catch { /* A later event or explicit user read can recover without timers. */ }
        finally {
            refreshing = false;
            // A newly selected feature may have received events during an old generation's read.
            if (invalidated && !disposed) void refresh(generation);
        }
    };
    const catalog = async () => readCatalog(await discoverRoots(workingDirectory, options.homeDirectory));
    const wrap = (handler: (input: any) => Promise<any>) => async (input: any) => {
        try { if (disposed) throw new Error('Goal Board session is closed'); return await handler(input); }
        catch (error) { return { success: false, error: (error instanceof Error ? error.message : 'Goal Board request failed').slice(0, 2048) }; }
    };
    manager.registerHandler('goalBoardCatalog', wrap(async () => ({
        success: true,
        goals: (await catalog()).map(({ root: _root, ...entry }) => entry),
    })));
    const readFeature = wrap(async (input) => {
        if (!input || typeof input.featurePath !== 'string' || input.featurePath.length > 8192) throw new Error('A feature path is required');
        const requestEpoch = ++generation;
        closeWatchers();
        active = null;
        snapshot = null;
        attachments.clear();
        const candidatePath = await realpath(input.featurePath);
        assertCurrent(requestEpoch);
        const entry = (await catalog()).find(item => item.featurePath === candidatePath);
        assertCurrent(requestEpoch);
        if (!entry) throw new Error('Feature is outside the authorized Goal catalog');
        active = entry;
        await watchDirectories([entry.featurePath], requestEpoch);
        assertCurrent(requestEpoch);
        const parsed = await parseBoard(entry);
        assertCurrent(requestEpoch);
        await watchDirectories(parsed.watchDirectories, requestEpoch);
        assertCurrent(requestEpoch);
        snapshot = parsed.snapshot;
        await publish(parsed.snapshot, requestEpoch);
        assertCurrent(requestEpoch);
        return { success: true, snapshot: parsed.snapshot };
    });
    manager.registerHandler('goalBoardRead', readFeature);
    if (options.initialFeaturePath) {
        void Promise.resolve().then(() => { if (!disposed && generation === 0) return readFeature({ featurePath: options.initialFeaturePath }); return undefined; });
    }
    const selectedTask = async (input: any) => {
        const epoch = generation;
        const featurePath = typeof input?.featurePath === 'string' ? await realpath(input.featurePath) : '';
        assertCurrent(epoch);
        if (featurePath !== snapshot?.featurePath || !active) throw new Error('Feature is not the selected Goal snapshot');
        const task = snapshot.tasks.find(item => item.id === input.taskId);
        if (!task) throw new Error('Task is not in the selected Goal snapshot');
        return { task, entry: active, epoch: generation };
    };
    manager.registerHandler('goalBoardArtifact', wrap(async (input) => {
        const { task, entry, epoch } = await selectedTask(input);
        const artifact = task.artifacts.find(item => item.id === input.artifactId);
        if (!artifact) throw new Error('Artifact is not in the selected task');
        if (!artifact.available || !artifact.path) throw new Error('Original file is unavailable or outside the authorized Goal root');
        if (['url', 'commit', 'unsupported'].includes(artifact.kind)) throw new Error('This artifact type cannot be previewed');
        const path = await safePath(entry.root, artifact.path);
        const info = await stat(path);
        assertCurrent(epoch);
        if (!info.isFile()) throw new Error('Artifact is not a regular file');
        const maxBytes = artifact.kind === 'text' ? GOAL_ARTIFACT_MAX_TEXT_BYTES : ['audio', 'video'].includes(artifact.kind) ? 500 * 1024 * 1024 : artifact.kind === 'pdf' ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
        if (info.size > maxBytes) throw new Error(`File too large (maximum ${maxBytes} bytes)`);
        const revision = digest(`${artifact.id}:${info.mtimeMs}:${info.size}`);
        if (artifact.kind === 'text' && info.size <= GOAL_ARTIFACT_MAX_INLINE_TEXT_BYTES) {
            const raw = await readBoundedFile(entry.root, path, GOAL_ARTIFACT_MAX_INLINE_TEXT_BYTES);
            assertCurrent(epoch);
            if (raw.includes(0)) throw new Error('Binary file cannot be read as text');
            return { success: true, kind: 'text', content: new TextDecoder('utf-8', { fatal: true }).decode(raw), revision, name: artifact.name };
        }
        const cacheKey = `${entry.featurePath}:${artifact.id}:${revision}`;
        let pending = attachments.get(cacheKey);
        if (!pending) {
            // Copy from an authorized FD before the existing uploader can await any network descriptor.
            pending = withStagedAttachment(entry.root, path, maxBytes, () => assertCurrent(epoch), stagedPath => options.prepareAttachment(stagedPath, artifact.kind));
            if (attachments.size >= 64) attachments.delete(attachments.keys().next().value!);
            attachments.set(cacheKey, pending);
            void pending.catch(() => { if (attachments.get(cacheKey) === pending) attachments.delete(cacheKey); });
        }
        const attachment = await pending;
        assertCurrent(epoch);
        return { success: true, kind: 'attachment', attachment };
    }));
    manager.registerHandler('goalBoardStartTask', wrap(async (input) => {
        const { task, entry, epoch } = await selectedTask(input);
        if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128) throw new Error('A bounded task request ID is required');
        if (!options.startTask) throw new Error('Independent task sessions are unavailable');
        assertCurrent(epoch);
        let launch = taskLaunches.get(input.requestId);
        if (launch && (launch.featurePath !== entry.featurePath || launch.task.id !== task.id)) {
            throw new Error('requestId was already used for a different task');
        }
        if (!launch) {
            if (taskLaunches.size >= 128) throw new Error('Task launch limit reached for this session');
            launch = { featurePath: entry.featurePath, task: structuredClone(task) };
            taskLaunches.set(input.requestId, launch);
        }
        // Preserve the first title/prompt inputs across retryable/uncertain delivery failures.
        // Launching a session does not mutate the authoritative task status.
        return options.startTask(launch.task, launch.featurePath, input.requestId);
    }));
    return { dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        closeWatchers();
        attachments.clear();
        taskLaunches.clear();
        snapshot = null;
        active = null;
        for (const method of ['goalBoardCatalog', 'goalBoardRead', 'goalBoardArtifact', 'goalBoardStartTask']) manager.unregisterHandler(method);
    } };
}
