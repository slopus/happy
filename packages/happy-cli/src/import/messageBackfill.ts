/**
 * Message Backfill
 *
 * Reads a Claude JSONL line by line, converts each entry to a session
 * envelope via the existing mapClaudeLogMessageToSessionEnvelopes mapper,
 * and pushes them to happy-server through the standard ApiSessionClient
 * pipeline.
 *
 * Why reuse ApiSessionClient instead of POSTing /v3/sessions/<id>/messages
 * directly?
 *   - mapClaudeLogMessageToSessionEnvelopes is stateful (tracks subagents,
 *     turn IDs, sidechains). ApiSessionClient owns that state in its
 *     `claudeSessionProtocolState` field and the same instance must process
 *     every line of the conversation.
 *   - Encryption + retries + batched flushing (max 50 per batch via
 *     pendingOutbox) is already implemented inside the client. Recreating
 *     it here would just duplicate code.
 *
 * Resume note: the JSONL may grow if the user runs native `claude --resume`
 * after import. The journal records `backfilledLineCount`; on a re-import
 * pass we skip already-replayed lines so we don't push duplicates.
 *
 * Note on duplication: the server allocates `seq` on its side and does
 * NOT dedupe by content. If `backfilledLineCount` is wrong (e.g. corrupted
 * journal) you'll get duplicate messages in the happy session. The
 * conservative default is "skip backfill" if backfilledLineCount is unknown.
 */

import { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

import { iterateJsonl } from './jsonlParser';

export type BackfillResult = {
    /** Total lines successfully sent to the server in this call. */
    sentLines: number;
    /** Total lines walked (sent + skipped due to skipUntilLineIndex). */
    walkedLines: number;
    status: 'complete' | 'partial' | 'failed';
    error?: string;
};

export type BackfillOptions = {
    /** Skip the first N lines that were already backfilled previously. */
    skipUntilLineIndex?: number;
    /**
     * Soft per-flush cap so we don't accumulate hundreds of MB in memory
     * before the outbox drains. Defaults to 200 — the client itself caps
     * individual batches at 50, so this is "send 4 batches then await flush
     * before queuing more".
     */
    flushEveryNLines?: number;
};

/**
 * Backfill a JSONL into an already-created happy session.
 *
 * The caller must:
 *   1. Have created the session with `api.getOrCreateSession(...)`
 *   2. Have constructed an `ApiSessionClient` for that session
 *   3. Wait for the client's socket to connect (the client auto-connects
 *      in its constructor; one short `await` on a connect event is enough,
 *      OR just queue messages and let them go out once connection completes
 *      — the outbox is durable across reconnects)
 *
 * After this returns 'complete' the caller MUST call `client.flush()` and
 * then close the session client. We don't do that here so the caller can
 * also call `client.updateMetadata(...)` to set `lifecycleState: 'archived'`
 * before closing.
 */
export async function backfillJsonl(
    client: ApiSessionClient,
    jsonlPath: string,
    opts: BackfillOptions = {},
): Promise<BackfillResult> {
    const skipUntil = opts.skipUntilLineIndex ?? 0;
    const flushEvery = opts.flushEveryNLines ?? 200;

    let walked = 0;
    let sent = 0;

    try {
        for await (const row of iterateJsonl(jsonlPath)) {
            walked++;
            if (walked <= skipUntil) continue;

            try {
                client.sendClaudeSessionMessage(row);
                sent++;
            } catch (error: any) {
                // The mapper itself can throw on malformed but schema-passing
                // data. Skip the row, keep going — losing one row beats
                // aborting the whole import.
                logger.debug(`[import] mapper threw on line ${walked} of ${jsonlPath}: ${error?.message}`);
            }

            if (sent > 0 && sent % flushEvery === 0) {
                // Backpressure: wait for the outbox to drain before we let
                // it accumulate another batch. flush() polls socket-ack so
                // it's safe to call repeatedly.
                await client.flush();
            }
        }

        // Close the turn so the UI doesn't show an "agent typing" state
        // for the imported session. closeClaudeTurnWithStatus emits the
        // turn-end envelope through the same pipeline.
        try {
            client.closeClaudeSessionTurn('completed');
        } catch (error: any) {
            logger.debug(`[import] closeClaudeSessionTurn failed: ${error?.message}`);
        }

        await client.flush();

        return { sentLines: sent, walkedLines: walked, status: 'complete' };
    } catch (error: any) {
        logger.debug(`[import] backfill failed at line ${walked} of ${jsonlPath}: ${error?.message}`);
        // Try to flush whatever we sent so the partial state on the server
        // matches sentLines (so the next re-import resumes from the right line).
        try { await client.flush(); } catch { /* swallow */ }
        return {
            sentLines: sent,
            walkedLines: walked,
            status: sent > 0 ? 'partial' : 'failed',
            error: error?.message ?? String(error),
        };
    }
}
