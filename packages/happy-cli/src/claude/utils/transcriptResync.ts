/**
 * Resuming a Happy session on an existing Claude conversation: which JSONL entries does the session
 * history not have yet, and sending them (reconnect backfill).
 *
 * The conversation may have continued outside Happy (plain `claude --resume`) while Happy was not
 * running. Those entries are in Claude's JSONL but were never sent. The session history records the
 * Claude uuid of what was sent (`claudeUuid` on session-protocol envelopes), so everything after the
 * last JSONL entry the history knows is new. User messages typed in the app carry no claudeUuid; the
 * ones after the last known entry are matched by text so they are not sent twice.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/ui/logger';
import { RawJSONLinesSchema, type RawJSONLines } from '../types';
import { getProjectPath } from './path';

/** What the session history already holds of the Claude conversation. */
export type SyncedTranscript = {
    claudeUuids: Set<string>;
    /** Texts of app-typed user messages after the last message with a claudeUuid, oldest first. */
    trailingUserTexts: string[];
};

/** Builds a SyncedTranscript from decrypted session history bodies, in history (seq) order. */
export function collectSyncedTranscript(bodies: unknown[]): SyncedTranscript {
    const claudeUuids = new Set<string>();
    let trailingUserTexts: string[] = [];
    for (const body of bodies) {
        const record = body as { role?: unknown; content?: { claudeUuid?: unknown; type?: unknown; text?: unknown } } | null;
        if (record?.role === 'session' && typeof record.content?.claudeUuid === 'string') {
            claudeUuids.add(record.content.claudeUuid);
            trailingUserTexts = [];
        } else if (record?.role === 'user' && record.content?.type === 'text' && typeof record.content.text === 'string') {
            trailingUserTexts.push(record.content.text);
        }
    }
    return { claudeUuids, trailingUserTexts };
}

type TranscriptEntry = { type: string; uuid?: string; message?: unknown };

/**
 * Indexes of the entries to send: those after the last entry whose uuid the history knows, minus
 * user entries already in the history as app-typed messages. `null` when the history knows none of
 * the entries (e.g. a rewritten conversation): callers then treat the file as already sent.
 */
export function unsyncedEntryIndexes(entries: TranscriptEntry[], synced: SyncedTranscript): number[] | null {
    let last = -1;
    entries.forEach((entry, index) => {
        if (entry.uuid && synced.claudeUuids.has(entry.uuid)) last = index;
    });
    if (last === -1) return null;

    const pendingAppTexts = [...synced.trailingUserTexts];
    const indexes: number[] = [];
    for (let index = last + 1; index < entries.length; index++) {
        const entry = entries[index];
        const text = (entry.message as { content?: unknown } | undefined)?.content;
        if (entry.type === 'user' && typeof text === 'string' && pendingAppTexts[0] === text) {
            pendingAppTexts.shift();
            continue;
        }
        indexes.push(index);
    }
    return indexes;
}

/** How long to wait for the session history before giving up on the backfill. */
const SYNCED_TRANSCRIPT_TIMEOUT_MS = 10_000;

/**
 * Reconnect backfill: sends the entries of the Claude conversation that the session history lacks.
 * Run once when reattaching to a Happy session, before the scanners start (they treat what is on disk
 * as already sent). Returns the number of entries sent.
 */
export async function backfillUnsyncedTranscript(opts: {
    synced: Promise<SyncedTranscript> | null;
    workingDirectory: string;
    claudeSessionId: string;
    send: (message: RawJSONLines) => Promise<void>;
    timeoutMs?: number;
}): Promise<number> {
    if (!opts.synced) return 0;
    const synced = await withTimeout(opts.synced, opts.timeoutMs ?? SYNCED_TRANSCRIPT_TIMEOUT_MS);
    if (!synced) {
        logger.debug('[RECONNECT BACKFILL] Session history not available; nothing sent');
        return 0;
    }
    const jsonlPath = join(getProjectPath(opts.workingDirectory), `${opts.claudeSessionId}.jsonl`);
    let file: string;
    try {
        file = await readFile(jsonlPath, 'utf-8');
    } catch (error) {
        logger.debug(`[RECONNECT BACKFILL] Failed to read ${jsonlPath}:`, error);
        return 0;
    }
    const entries: RawJSONLines[] = [];
    for (const line of file.split('\n')) {
        if (line.trim().length === 0) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const result = RawJSONLinesSchema.safeParse(parsed);
        if (result.success && result.data.type !== 'summary') entries.push(result.data);
    }
    const indexes = unsyncedEntryIndexes(entries, synced);
    if (!indexes) {
        logger.debug(`[RECONNECT BACKFILL] The session history knows none of the ${entries.length} entries in ${jsonlPath}; nothing sent`);
        return 0;
    }
    for (const index of indexes) {
        await opts.send(entries[index]);
    }
    logger.debug(`[RECONNECT BACKFILL] Sent ${indexes.length} of ${entries.length} entries missing from the session history`);
    return indexes.length;
}

/** Resolves to the promise's value, or `null` if it rejects or does not settle within `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    try {
        return await Promise.race([promise.catch(() => null), timeout]);
    } finally {
        clearTimeout(timer);
    }
}
