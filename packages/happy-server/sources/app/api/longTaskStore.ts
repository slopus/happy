import { randomUUID } from "crypto";

export type LongTaskState = "accepted" | "running" | "succeeded" | "failed";

export interface LongTaskRecord<Result = undefined> {
    id: string;
    ownerId: string;
    kind: string;
    state: LongTaskState;
    stage: string;
    createdAt: string;
    updatedAt: string;
    heartbeatAt: string;
    pollAfterMs: number;
    error?: string;
    errorCode?: string;
    result?: Result;
}

type CreateLongTaskInput = {
    ownerId: string;
    kind: string;
    stage?: string;
    pollAfterMs?: number;
};

type UpdateLongTaskInput<Result = undefined> = {
    state?: LongTaskState;
    stage?: string;
    pollAfterMs?: number;
    error?: string;
    errorCode?: string;
    result?: Result;
    heartbeat?: boolean;
};

const DEFAULT_POLL_AFTER_MS = 500;
const TERMINAL_TTL_MS = 10 * 60 * 1000;
const tasks = new Map<string, LongTaskRecord<any>>();

function nowIso(): string {
    return new Date().toISOString();
}

function pruneExpiredTasks(now = Date.now()) {
    for (const [taskId, task] of tasks.entries()) {
        if ((task.state === "succeeded" || task.state === "failed") && now - Date.parse(task.updatedAt) > TERMINAL_TTL_MS) {
            tasks.delete(taskId);
        }
    }
}

export function createLongTask(input: CreateLongTaskInput): LongTaskRecord {
    pruneExpiredTasks();
    const now = nowIso();
    const task: LongTaskRecord = {
        id: randomUUID(),
        ownerId: input.ownerId,
        kind: input.kind,
        state: "accepted",
        stage: input.stage ?? "accepted",
        createdAt: now,
        updatedAt: now,
        heartbeatAt: now,
        pollAfterMs: input.pollAfterMs ?? DEFAULT_POLL_AFTER_MS
    };
    tasks.set(task.id, task);
    return { ...task };
}

export function getLongTask(taskId: string, ownerId: string): LongTaskRecord | null {
    pruneExpiredTasks();
    const task = tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) {
        return null;
    }
    return { ...task };
}

export function updateLongTask<Result = undefined>(taskId: string, ownerId: string, update: UpdateLongTaskInput<Result>): LongTaskRecord | null {
    const task = tasks.get(taskId);
    if (!task || task.ownerId !== ownerId) {
        return null;
    }

    const now = nowIso();
    if (update.state) {
        task.state = update.state;
    }
    if (update.stage) {
        task.stage = update.stage;
    }
    if (typeof update.pollAfterMs === "number") {
        task.pollAfterMs = update.pollAfterMs;
    }
    if (Object.prototype.hasOwnProperty.call(update, "error")) {
        task.error = update.error;
    }
    if (Object.prototype.hasOwnProperty.call(update, "errorCode")) {
        task.errorCode = update.errorCode;
    }
    if (Object.prototype.hasOwnProperty.call(update, "result")) {
        task.result = update.result;
    }
    task.updatedAt = now;
    if (update.heartbeat || update.stage || update.state) {
        task.heartbeatAt = now;
    }

    return { ...task };
}

export async function withLongTaskHeartbeat<T>(
    taskId: string,
    ownerId: string,
    callback: () => Promise<T>,
    intervalMs = 1000
): Promise<T> {
    const interval = setInterval(() => {
        updateLongTask(taskId, ownerId, { heartbeat: true });
    }, intervalMs);

    try {
        return await callback();
    } finally {
        clearInterval(interval);
        updateLongTask(taskId, ownerId, { heartbeat: true });
    }
}

export function __resetLongTaskStoreForTests() {
    tasks.clear();
}
