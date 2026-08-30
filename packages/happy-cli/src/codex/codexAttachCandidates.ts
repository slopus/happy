/**
 * Discovers Codex Desktop threads that have not yet been attached to Paws.
 * Candidate transcripts remain local; only lightweight title/path metadata is
 * returned to the authenticated Paws client through machine-scoped RPC.
 */

import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { ListedThread, ThreadListResponse } from './codexAppServerTypes';
import { resolveCodexHome } from './codexHome';

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type CodexAttachCandidate = {
    threadId: string;
    title: string;
    directory: string;
    createdAt: number;
    updatedAt: number;
};

type CandidateState = {
    version: 1;
    dismissed: Record<string, number>;
    attached: Record<string, number>;
};

type CandidateServiceOptions = {
    statePath: string;
    listThreads: () => Promise<ThreadListResponse>;
    now?: () => number;
    maxAgeMs?: number;
    limit?: number;
    readThreadOriginator?: (path: string) => Promise<string | null>;
};

const EMPTY_STATE: CandidateState = { version: 1, dismissed: {}, attached: {} };

type CodexStateThreadRow = {
    id: unknown;
    rolloutPath: unknown;
    cwd: unknown;
    name: unknown;
    title: unknown;
    preview: unknown;
    createdAt: unknown;
    updatedAt: unknown;
    recencyAt: unknown;
    source: unknown;
    archived: unknown;
    parentThreadId: unknown;
};

type ReadonlyDatabase = {
    prepare(sql: string): { all(...params: unknown[]): unknown[] };
    close(): void;
};

type OpenReadonlyDatabase = (path: string) => ReadonlyDatabase;

function openReadonlyDatabase(path: string): ReadonlyDatabase {
    // node:sqlite is available in the Node 24 runtime used by the managed daemon.
    // Loading it through createRequire keeps older TypeScript declarations from
    // rejecting the built-in module during the CLI build.
    const require = createRequire(import.meta.url);
    const sqlite = require('node:sqlite') as {
        DatabaseSync: new (filename: string, options: { readOnly: boolean; timeout: number }) => ReadonlyDatabase;
    };
    return new sqlite.DatabaseSync(path, { readOnly: true, timeout: 1_000 });
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads only the lightweight Codex thread index. This deliberately avoids a
 * second app-server client while Codex Desktop or Paws is actively using the
 * shared process; takeover itself still resumes through that shared process.
 */
export function listCodexThreadsFromStateDb(options: {
    codexHome?: string;
    limit?: number;
    now?: () => number;
    maxAgeMs?: number;
    openDatabase?: OpenReadonlyDatabase;
} = {}): ThreadListResponse {
    const database = (options.openDatabase ?? openReadonlyDatabase)(
        join(options.codexHome ?? resolveCodexHome(), 'state_5.sqlite'),
    );
    try {
        const limit = options.limit;
        const oldestAllowedSeconds = Math.floor(
            ((options.now ?? Date.now)() - (options.maxAgeMs ?? DEFAULT_MAX_AGE_MS)) / 1000,
        );
        const rows = database.prepare(`
            SELECT
                threads.id AS id,
                threads.rollout_path AS rolloutPath,
                threads.cwd AS cwd,
                threads.name AS name,
                threads.title AS title,
                threads.preview AS preview,
                threads.created_at AS createdAt,
                threads.updated_at AS updatedAt,
                threads.recency_at AS recencyAt,
                threads.source AS source,
                threads.archived AS archived,
                thread_spawn_edges.parent_thread_id AS parentThreadId
            FROM threads
            LEFT JOIN thread_spawn_edges
                ON thread_spawn_edges.child_thread_id = threads.id
            WHERE threads.source = 'vscode'
                AND threads.archived = 0
                AND threads.recency_at >= ?
            ORDER BY threads.recency_at DESC, threads.id DESC
            ${limit === undefined ? '' : 'LIMIT ?'}
        `).all(...(limit === undefined
            ? [oldestAllowedSeconds]
            : [oldestAllowedSeconds, limit])) as CodexStateThreadRow[];

        return {
            data: rows.flatMap((row): ListedThread[] => {
                const id = optionalString(row.id);
                const path = optionalString(row.rolloutPath);
                const cwd = optionalString(row.cwd);
                if (!id || !path || !cwd || row.source !== 'vscode') return [];

                return [{
                    id,
                    path,
                    cwd,
                    name: optionalString(row.name) ?? optionalString(row.title) ?? null,
                    preview: optionalString(row.preview) ?? optionalString(row.title) ?? '',
                    createdAt: optionalNumber(row.createdAt),
                    updatedAt: optionalNumber(row.updatedAt),
                    recencyAt: optionalNumber(row.recencyAt),
                    source: 'vscode',
                    archived: row.archived === 1,
                    parentThreadId: optionalString(row.parentThreadId) ?? null,
                    ephemeral: false,
                }];
            }),
            nextCursor: null,
        };
    } finally {
        database.close();
    }
}

function secondsToMilliseconds(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : 0;
}

function extractCandidateTitle(name: string | null | undefined, preview: string | undefined): string {
    const explicitName = name?.trim();
    if (explicitName) return explicitName;

    return (preview ?? '')
        .replace(/<!-- happy:system-prompt:start -->[\s\S]*?<!-- happy:system-prompt:end -->/g, ' ')
        .replace(/^Happy attached .*$/gim, ' ')
        .replace(/^Use these exact localImage paths.*$/gim, ' ')
        .replace(/^Do not infer the intended upload.*$/gim, ' ')
        .replace(/^- Image \d+: .*$/gim, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
}

function toCandidate(thread: ListedThread): CodexAttachCandidate | null {
    const source = thread.source;
    const title = extractCandidateTitle(thread.name, thread.preview);
    const directory = typeof thread.cwd === 'string' ? thread.cwd.trim() : '';

    if (source !== 'vscode' || thread.parentThreadId || thread.ephemeral || thread.archived || !title || !directory) {
        return null;
    }

    return {
        threadId: thread.id,
        title,
        directory,
        createdAt: secondsToMilliseconds(thread.createdAt),
        updatedAt: secondsToMilliseconds(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt),
    };
}

export async function readCodexThreadOriginator(path: string): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(path, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
        const record = JSON.parse(firstLine) as {
            type?: string;
            payload?: { originator?: unknown };
        };
        return record.type === 'session_meta' && typeof record.payload?.originator === 'string'
            ? record.payload.originator
            : null;
    } catch {
        return null;
    } finally {
        await handle?.close();
    }
}

async function loadState(statePath: string): Promise<CandidateState> {
    try {
        const parsed = JSON.parse(await readFile(statePath, 'utf8')) as Partial<CandidateState>;
        return {
            version: 1,
            dismissed: parsed.dismissed && typeof parsed.dismissed === 'object' ? parsed.dismissed : {},
            attached: parsed.attached && typeof parsed.attached === 'object' ? parsed.attached : {},
        };
    } catch {
        return { ...EMPTY_STATE, dismissed: {}, attached: {} };
    }
}

async function saveState(statePath: string, state: CandidateState): Promise<void> {
    await mkdir(dirname(statePath), { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, statePath);
}

export function createCodexAttachCandidateService(options: CandidateServiceOptions) {
    const now = options.now ?? Date.now;
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    const limit = options.limit;
    const readThreadOriginator = options.readThreadOriginator ?? readCodexThreadOriginator;
    let stateWriteQueue = Promise.resolve();

    const updateState = (kind: 'dismissed' | 'attached', threadId: string): Promise<void> => {
        const operation = stateWriteQueue.then(async () => {
            const state = await loadState(options.statePath);
            state[kind][threadId] = now();
            await saveState(options.statePath, state);
        });
        stateWriteQueue = operation.catch(() => undefined);
        return operation;
    };

    return {
        async list({ existingThreadIds }: { existingThreadIds: string[] }): Promise<CodexAttachCandidate[]> {
            const [state, response] = await Promise.all([loadState(options.statePath), options.listThreads()]);
            const excluded = new Set([
                ...existingThreadIds,
                ...Object.keys(state.dismissed),
                ...Object.keys(state.attached),
            ]);
            const oldestAllowed = now() - maxAgeMs;

            const candidates = await Promise.all(response.data.map(async (thread) => {
                const candidate = toCandidate(thread);
                if (!candidate || typeof thread.path !== 'string') return null;
                return await readThreadOriginator(thread.path) === 'Codex Desktop' ? candidate : null;
            }));

            const eligible = candidates
                .filter((candidate): candidate is CodexAttachCandidate => Boolean(
                    candidate
                    && !excluded.has(candidate.threadId)
                    && candidate.updatedAt >= oldestAllowed,
                ))
                .sort((a, b) => b.updatedAt - a.updatedAt);
            return limit === undefined ? eligible : eligible.slice(0, limit);
        },
        dismiss(threadId: string): Promise<void> {
            return updateState('dismissed', threadId);
        },
        markAttached(threadId: string): Promise<void> {
            return updateState('attached', threadId);
        },
    };
}
