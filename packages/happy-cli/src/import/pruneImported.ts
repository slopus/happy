/**
 * Prune Imported Sessions
 *
 * Removes journal entries (and the corresponding happy Session rows on the
 * server) for imports whose JSONL is older than a cutoff. Used to walk back
 * an auto-import cycle that accidentally pulled in historical sessions
 * (e.g., before the recency filter was added).
 *
 * What gets removed for each pruned entry:
 *   1. DELETE /v1/sessions/<happySessionId> on the server (Session row +
 *      all SessionMessage rows cascade away)
 *   2. The entry is removed from ~/.happy/imported-sessions.json so the
 *      next auto-import scan can re-discover the JSONL if user wants.
 *
 * Tail-backfills from now on will simply skip these — they're no longer in
 * the journal.
 */

import axios from 'axios';

import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';
import { readCredentials } from '@/persistence';
import { logger } from '@/ui/logger';

import { readImportJournal, updateImportJournal } from './importJournal';

export type PruneResult = {
    happySessionId: string;
    claudeSessionId: string;
    cwd: string;
    status: 'deleted' | 'failed' | 'kept-not-old-enough';
    error?: string;
};

/**
 * Prune journal entries whose underlying JSONL mtime is older than
 * `olderThanMs` (epoch-ms cutoff — anything BEFORE this is pruned).
 *
 * Pass `dryRun: true` to see what would be deleted without actually deleting.
 */
export async function pruneImportedSessionsOlderThan(
    _api: ApiClient,
    olderThanMs: number,
    options: { dryRun?: boolean } = {},
): Promise<PruneResult[]> {
    const journal = await readImportJournal();
    const credentials = await readCredentials();
    if (!credentials) {
        throw new Error('No credentials — cannot delete sessions on the server.');
    }

    const results: PruneResult[] = [];
    const idsToRemoveFromJournal: string[] = [];

    for (const entry of Object.values(journal.imported)) {
        const mtime = entry.jsonlMtimeMs ?? entry.importedAt;
        if (mtime >= olderThanMs) {
            results.push({
                happySessionId: entry.happySessionId,
                claudeSessionId: entry.claudeSessionId,
                cwd: entry.cwd,
                status: 'kept-not-old-enough',
            });
            continue;
        }

        if (options.dryRun) {
            results.push({
                happySessionId: entry.happySessionId,
                claudeSessionId: entry.claudeSessionId,
                cwd: entry.cwd,
                status: 'deleted', // pretend
            });
            continue;
        }

        try {
            await axios.delete(`${configuration.serverUrl}/v1/sessions/${entry.happySessionId}`, {
                headers: {
                    Authorization: `Bearer ${credentials.token}`,
                    'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
                },
                timeout: 15_000,
            });
            idsToRemoveFromJournal.push(entry.claudeSessionId);
            results.push({
                happySessionId: entry.happySessionId,
                claudeSessionId: entry.claudeSessionId,
                cwd: entry.cwd,
                status: 'deleted',
            });
        } catch (error: any) {
            // 404 = already gone on server (someone deleted it from another machine
            // or the user archived it manually). Still remove from journal — there's
            // nothing left to track.
            const status = error?.response?.status;
            if (status === 404) {
                idsToRemoveFromJournal.push(entry.claudeSessionId);
                results.push({
                    happySessionId: entry.happySessionId,
                    claudeSessionId: entry.claudeSessionId,
                    cwd: entry.cwd,
                    status: 'deleted',
                });
            } else {
                logger.debug(`[prune] DELETE failed for ${entry.happySessionId}: ${error?.message}`);
                results.push({
                    happySessionId: entry.happySessionId,
                    claudeSessionId: entry.claudeSessionId,
                    cwd: entry.cwd,
                    status: 'failed',
                    error: error?.message ?? String(error),
                });
            }
        }
    }

    if (idsToRemoveFromJournal.length > 0 && !options.dryRun) {
        await updateImportJournal((current) => {
            const next = { ...current.imported };
            for (const id of idsToRemoveFromJournal) {
                delete next[id];
            }
            return { ...current, imported: next };
        });
    }

    return results;
}
