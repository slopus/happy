/**
 * Tails a Kimi Code `wire.jsonl` transcript and turns it into session envelopes.
 *
 * The local mode runs Kimi's own TUI, which offers no streaming interface — the
 * transcript on disk is the only live view of the conversation. Kimi appends to
 * it as the turn progresses (setup records land before the first prompt), so a
 * plain incremental tail is enough to mirror the session to the mobile app.
 *
 * Reads are offset-based: only the bytes appended since the previous read are
 * parsed, and a trailing partial line is held back until its newline arrives.
 */

import { open, stat } from 'node:fs/promises';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { startFileWatcher } from '@/modules/watcher/startFileWatcher';
import { InvalidateSync } from '@/utils/sync';
import {
    closeKimiTurn,
    createKimiWireState,
    mapKimiWireRecordToSessionEnvelopes,
    type KimiWireState,
} from './kimiWireMapper';

export type KimiSessionScanner = {
    /** Flush anything appended since the last read. */
    sync: () => Promise<void>;
    /** Stop watching and close any turn left open by an interrupted process. */
    stop: (status?: 'completed' | 'failed' | 'cancelled') => Promise<void>;
};

type TailState = {
    offset: number;
    partial: string;
};

async function readAppendedLines(file: string, tail: TailState): Promise<string[]> {
    let size: number;
    try {
        size = (await stat(file)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.debug('[kimi] Failed to stat wire transcript:', error);
        }
        return [];
    }

    // Kimi rewrites the transcript when a session is compacted; restart the tail.
    if (size < tail.offset) {
        logger.debug('[kimi] Wire transcript shrank, restarting tail from 0');
        tail.offset = 0;
        tail.partial = '';
    }
    if (size === tail.offset) {
        return [];
    }

    const handle = await open(file, 'r');
    try {
        const length = size - tail.offset;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, tail.offset);
        tail.offset += bytesRead;

        const chunk = tail.partial + buffer.subarray(0, bytesRead).toString('utf8');
        const lines = chunk.split('\n');
        // The last element is either '' (chunk ended on a newline) or a line
        // still being written — hold it until the rest arrives.
        tail.partial = lines.pop() ?? '';
        return lines.filter((line) => line.trim().length > 0);
    } finally {
        await handle.close();
    }
}

/**
 * Start mirroring `wireFile`. Envelopes are emitted in transcript order; the
 * caller forwards them to the Happy session.
 */
export function createKimiSessionScanner(opts: {
    wireFile: string;
    onEnvelopes: (envelopes: SessionEnvelope[]) => void;
    /** Skip records already on disk — used when resuming a mirrored session. */
    startAtEnd?: boolean;
    state?: KimiWireState;
}): KimiSessionScanner {
    const state = opts.state ?? createKimiWireState();
    const tail: TailState = { offset: 0, partial: '' };
    let primed = !opts.startAtEnd;

    const pump = async (): Promise<void> => {
        if (!primed) {
            // Fast-forward past existing content without emitting it.
            try {
                tail.offset = (await stat(opts.wireFile)).size;
            } catch {
                tail.offset = 0;
            }
            primed = true;
            return;
        }

        const lines = await readAppendedLines(opts.wireFile, tail);
        if (lines.length === 0) {
            return;
        }

        const envelopes: SessionEnvelope[] = [];
        for (const line of lines) {
            let record: unknown;
            try {
                record = JSON.parse(line);
            } catch (error) {
                logger.debug('[kimi] Skipping unparsable wire line:', error);
                continue;
            }
            envelopes.push(...mapKimiWireRecordToSessionEnvelopes(record, state));
        }

        if (envelopes.length > 0) {
            opts.onEnvelopes(envelopes);
        }
    };

    const sync = new InvalidateSync(pump);
    const stopWatching = startFileWatcher(opts.wireFile, () => sync.invalidate());
    sync.invalidate();

    return {
        sync: async () => {
            await sync.invalidateAndAwait();
        },
        stop: async (status = 'completed') => {
            stopWatching();
            await sync.invalidateAndAwait();
            sync.stop();
            const trailing = closeKimiTurn(state, status);
            if (trailing.length > 0) {
                opts.onEnvelopes(trailing);
            }
        },
    };
}
