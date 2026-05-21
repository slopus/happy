/**
 * Workspace-local I/O for `.ax/state.json` and `.ax/events.jsonl`.
 *
 * - State writes are atomic (tmp file + rename) so a crash mid-write can never
 *   leave a half-written `state.json`.
 * - Event appends are serialized through an in-process queue keyed by workspace
 *   path; concurrent callers don't tear each other's jsonl lines.
 * - Reads validate against the Zod schema and throw `StateFileCorruptError` on
 *   any malformed file so the bootstrap layer can decide to back-up + reset.
 */

import { mkdir, readFile, writeFile, rename, appendFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AxState, AxStateSchema } from './schema';

const AX_DIR = '.ax';
const STATE_FILE = 'state.json';
const EVENTS_FILE = 'events.jsonl';

export class StateFileCorruptError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
        super(message);
        this.name = 'StateFileCorruptError';
    }
}

export interface AxEvent {
    id: string;
    at: string;
    type: string;
    payload: Record<string, unknown>;
}

function statePath(workspaceRoot: string): string {
    return join(workspaceRoot, AX_DIR, STATE_FILE);
}

function eventsPath(workspaceRoot: string): string {
    return join(workspaceRoot, AX_DIR, EVENTS_FILE);
}

async function ensureAxDir(workspaceRoot: string): Promise<void> {
    await mkdir(join(workspaceRoot, AX_DIR), { recursive: true });
}

export async function readState(workspaceRoot: string): Promise<AxState> {
    const raw = await readFile(statePath(workspaceRoot), 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new StateFileCorruptError('state.json is not valid JSON', cause);
    }
    const result = AxStateSchema.safeParse(parsed);
    if (!result.success) {
        throw new StateFileCorruptError(
            `state.json does not match schema: ${result.error.message}`,
            result.error,
        );
    }
    return result.data;
}

export async function writeState(workspaceRoot: string, state: AxState): Promise<void> {
    AxStateSchema.parse(state);
    await ensureAxDir(workspaceRoot);
    const target = statePath(workspaceRoot);
    const tmp = `${target}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(state, null, 2) + '\n';
    try {
        await writeFile(tmp, payload, 'utf8');
        await rename(tmp, target);
    } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
    }
}

const appendQueues = new Map<string, Promise<void>>();

export async function appendEvent(workspaceRoot: string, event: AxEvent): Promise<void> {
    const key = eventsPath(workspaceRoot);
    const prev = appendQueues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
        await ensureAxDir(workspaceRoot);
        await appendFile(key, JSON.stringify(event) + '\n', 'utf8');
    });
    appendQueues.set(
        key,
        next.catch(() => {}),
    );
    return next;
}

export async function readEvents(workspaceRoot: string): Promise<AxEvent[]> {
    let raw: string;
    try {
        raw = await readFile(eventsPath(workspaceRoot), 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
    }
    return raw
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as AxEvent);
}
