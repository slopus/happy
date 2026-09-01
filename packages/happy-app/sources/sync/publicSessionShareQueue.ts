export type PublicSessionShareJobStatus = 'queued' | 'running' | 'ready' | 'failed';

export type PublicSessionShareJob = {
    id: string;
    sessionId: string;
    title: string;
    requestedAt: number;
    cutoffSeq: number;
    ownerId: string;
    serverUrl: string;
    groupToolCalls: boolean;
    status: PublicSessionShareJobStatus;
    progress: { completed: number; total: number };
    updatedAt: number;
    publicId?: string;
    publishedAt?: number;
    error?: string;
    notificationPending: boolean;
};

export type PublicSessionShareQueueStorage = {
    load: () => PublicSessionShareJob[];
    save: (jobs: PublicSessionShareJob[]) => void;
};

type PublicSessionShareJobInput = Pick<
    PublicSessionShareJob,
    'sessionId' | 'title' | 'requestedAt' | 'cutoffSeq' | 'ownerId' | 'serverUrl' | 'groupToolCalls'
>;

type PublicSessionShareJobResult = { publicId: string; publishedAt: number };

type PublicSessionShareQueueDependencies = {
    storage: PublicSessionShareQueueStorage;
    createId: () => string;
    execute: (
        job: PublicSessionShareJob,
        context: { onProgress: (completed: number, total: number) => void; isCancelled: () => boolean },
    ) => Promise<PublicSessionShareJobResult>;
    notify: (job: PublicSessionShareJob) => Promise<void>;
    canExecute?: (job: PublicSessionShareJob) => boolean;
    now?: () => number;
};

export function createPublicSessionShareQueue(deps: PublicSessionShareQueueDependencies) {
    const now = deps.now ?? Date.now;
    const canExecute = deps.canExecute ?? (() => true);
    const listeners = new Set<() => void>();
    const jobs = new Map<string, PublicSessionShareJob>();
    let processing: Promise<void> | null = null;

    for (const loaded of deps.storage.load()) {
        jobs.set(loaded.sessionId, loaded.status === 'running'
            ? { ...loaded, status: 'queued', updatedAt: now() }
            : loaded);
    }
    if (Array.from(jobs.values()).some((job) => job.status === 'queued')) {
        deps.storage.save(Array.from(jobs.values()));
    }

    const persist = () => {
        deps.storage.save(Array.from(jobs.values()));
        for (const listener of listeners) listener();
    };

    const replace = (job: PublicSessionShareJob) => {
        jobs.set(job.sessionId, job);
        persist();
        return job;
    };

    const processJobs = async () => {
        const attemptedNotifications = new Set<string>();
        while (true) {
            const pendingNotification = Array.from(jobs.values()).find((job) => (
                job.notificationPending
                && (job.status === 'ready' || job.status === 'failed')
                && canExecute(job)
                && !attemptedNotifications.has(job.id)
            ));
            if (pendingNotification) {
                try {
                    await deps.notify(pendingNotification);
                    const current = jobs.get(pendingNotification.sessionId);
                    if (current?.id === pendingNotification.id && current.notificationPending) {
                        replace({ ...current, notificationPending: false, updatedAt: now() });
                    }
                } catch {
                    attemptedNotifications.add(pendingNotification.id);
                }
                continue;
            }

            const queued = Array.from(jobs.values()).find((job) => job.status === 'queued' && canExecute(job));
            if (!queued) return;
            const running = replace({ ...queued, status: 'running', updatedAt: now(), error: undefined });
            const wasRemoved = () => jobs.get(running.sessionId)?.id !== running.id;
            const ownerChanged = () => !canExecute(running);
            const isCancelled = () => wasRemoved() || ownerChanged();
            try {
                const result = await deps.execute(running, {
                    isCancelled,
                    onProgress: (completed, total) => {
                        if (isCancelled()) return;
                        replace({
                            ...jobs.get(running.sessionId)!,
                            progress: { completed, total },
                            updatedAt: now(),
                        });
                    },
                });
                if (wasRemoved()) continue;
                if (ownerChanged()) {
                    replace({ ...jobs.get(running.sessionId)!, status: 'queued', updatedAt: now() });
                    continue;
                }
                replace({
                    ...jobs.get(running.sessionId)!,
                    status: 'ready',
                    publicId: result.publicId,
                    publishedAt: result.publishedAt,
                    notificationPending: true,
                    updatedAt: now(),
                });
            } catch (error) {
                if (wasRemoved()) continue;
                if (ownerChanged()) {
                    replace({ ...jobs.get(running.sessionId)!, status: 'queued', updatedAt: now() });
                    continue;
                }
                replace({
                    ...jobs.get(running.sessionId)!,
                    status: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                    notificationPending: true,
                    updatedAt: now(),
                });
            }
        }
    };

    const resume = () => {
        if (!processing) {
            processing = processJobs().finally(() => { processing = null; });
        }
        return processing;
    };

    return {
        enqueue(input: PublicSessionShareJobInput): PublicSessionShareJob {
            const existing = jobs.get(input.sessionId);
            if (existing?.status === 'queued' || existing?.status === 'running') return existing;
            const job = replace({
                id: deps.createId(),
                ...input,
                status: 'queued',
                progress: { completed: 0, total: 0 },
                notificationPending: false,
                updatedAt: now(),
            });
            void Promise.resolve().then(() => resume());
            return job;
        },
        cancel(sessionId: string): void {
            if (!jobs.delete(sessionId)) return;
            persist();
        },
        clear(): void {
            if (jobs.size === 0) return;
            jobs.clear();
            persist();
        },
        retry(sessionId: string): boolean {
            const failed = jobs.get(sessionId);
            if (failed?.status !== 'failed') return false;
            replace({ ...failed, status: 'queued', error: undefined, notificationPending: false, updatedAt: now() });
            void Promise.resolve().then(() => resume());
            return true;
        },
        getJob(sessionId: string): PublicSessionShareJob | null {
            return jobs.get(sessionId) ?? null;
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        resume,
    };
}
