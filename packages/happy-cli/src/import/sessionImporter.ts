/**
 * Session Importer
 *
 * Per-candidate orchestration:
 *   1. Build Happy `Metadata` from the JSONL header + machine info
 *   2. Call `apiClient.getOrCreateSession({ tag, metadata, state })` — the
 *      server-side tag is `claude-imported:<claudeSessionId>` so a lost
 *      local journal still dedupes against existing server rows.
 *   3. Open an `ApiSessionClient`, backfill messages, archive the session,
 *      flush, close.
 *   4. Record the result (including the encryption key captured at step 2)
 *      in the import journal.
 *
 * If anything fails after step 2 we still write a journal entry with the
 * partial status so the next `happy import` can resume from the failed
 * line index — and so the daemon can adopt-and-resume the session even
 * without messages backfilled.
 */

import os from 'node:os';
import { resolve as resolvePath } from 'node:path';

import { ApiClient } from '@/api/api';
import { encodeBase64 } from '@/api/encryption';
import type { AgentState, Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import packageJson from '../../package.json';

import { upsertEntry } from './importJournal';
import { backfillJsonl } from './messageBackfill';
import type { ImportCandidate } from './scanner';
import { countValidLines } from './jsonlParser';

export type ImportSessionOptions = {
    /** If false, skip message backfill and just create the empty session. */
    backfill?: boolean;
};

export type ImportSessionResult = {
    candidate: ImportCandidate;
    happySessionId: string | null;
    messagesBackfilled: number;
    status: 'created' | 'created-no-backfill' | 'partial' | 'failed';
    error?: string;
};

export async function importSingleSession(
    api: ApiClient,
    candidate: ImportCandidate,
    options: ImportSessionOptions = {},
): Promise<ImportSessionResult> {
    const backfill = options.backfill !== false;
    const { header, claudeSessionId, jsonlPath } = candidate;

    if (!header.firstCwd) {
        return {
            candidate,
            happySessionId: null,
            messagesBackfilled: 0,
            status: 'failed',
            error: 'JSONL has no cwd — cannot build session metadata.',
        };
    }

    const metadata = await buildMetadata(candidate);
    const state: AgentState = { controlledByUser: false };

    const tag = `claude-imported:${claudeSessionId}`;
    const session = await api.getOrCreateSession({ tag, metadata, state });
    if (!session) {
        return {
            candidate,
            happySessionId: null,
            messagesBackfilled: 0,
            status: 'failed',
            error: 'Server returned no session (likely offline). Try again when connected.',
        };
    }

    // Persist the encryption key NOW so even if backfill fails, the daemon
    // can still adopt-and-resume this session later.
    let totalLinesForJournal: number | undefined;
    try {
        totalLinesForJournal = await countValidLines(jsonlPath);
    } catch { /* ignore */ }

    await upsertEntry({
        claudeSessionId,
        happySessionId: session.id,
        cwd: header.firstCwd,
        jsonlPath,
        importedAt: Date.now(),
        encryptionKey: encodeBase64(session.encryptionKey),
        encryptionVariant: session.encryptionVariant,
        backfillStatus: backfill ? 'partial' : 'skipped',
        backfilledLineCount: 0,
        jsonlLineCount: totalLinesForJournal,
        jsonlMtimeMs: header.mtimeMs,
        jsonlSizeBytes: header.sizeBytes,
    });

    if (!backfill) {
        return {
            candidate,
            happySessionId: session.id,
            messagesBackfilled: 0,
            status: 'created-no-backfill',
        };
    }

    const client = api.sessionSyncClient(session);
    let messagesBackfilled = 0;
    let result;
    try {
        result = await backfillJsonl(client, jsonlPath);
        messagesBackfilled = result.sentLines;
    } catch (error: any) {
        logger.debug(`[import] unexpected error during backfill: ${error?.message}`);
        await client.close().catch(() => { });
        await upsertEntry({
            claudeSessionId,
            happySessionId: session.id,
            cwd: header.firstCwd,
            jsonlPath,
            importedAt: Date.now(),
            encryptionKey: encodeBase64(session.encryptionKey),
            encryptionVariant: session.encryptionVariant,
            backfillStatus: 'failed',
            backfilledLineCount: 0,
            jsonlLineCount: totalLinesForJournal,
            jsonlMtimeMs: header.mtimeMs,
            jsonlSizeBytes: header.sizeBytes,
        });
        return {
            candidate,
            happySessionId: session.id,
            messagesBackfilled: 0,
            status: 'failed',
            error: error?.message ?? String(error),
        };
    }

    // Mark the session as inactive on the server (active=false), so the
    // mobile app shows it in the "not currently running" state but with the
    // normal Resume affordance. We deliberately keep `lifecycleState` as
    // 'running' (not 'archived') because the app locks input on archived
    // sessions and the user has no way to trigger resume from there.
    try {
        await api.deactivateSession(session.id);
    } catch (error: any) {
        logger.debug(`[import] deactivateSession failed: ${error?.message}`);
    }

    await client.close().catch(() => { });

    const status: ImportSessionResult['status'] =
        result.status === 'complete' ? 'created'
            : result.status === 'partial' ? 'partial'
                : 'failed';

    await upsertEntry({
        claudeSessionId,
        happySessionId: session.id,
        cwd: header.firstCwd,
        jsonlPath,
        importedAt: Date.now(),
        encryptionKey: encodeBase64(session.encryptionKey),
        encryptionVariant: session.encryptionVariant,
        backfillStatus: result.status,
        backfilledLineCount: result.sentLines,
        jsonlLineCount: totalLinesForJournal,
        jsonlMtimeMs: header.mtimeMs,
        jsonlSizeBytes: header.sizeBytes,
    });

    return {
        candidate,
        happySessionId: session.id,
        messagesBackfilled,
        status,
        error: result.error,
    };
}

async function buildMetadata(candidate: ImportCandidate): Promise<Metadata> {
    const { header, claudeSessionId } = candidate;
    const settings = await readSettings();
    const cwd = header.firstCwd!; // checked by caller
    const title = header.firstUserText
        || header.summary?.summary
        || `Imported Claude session ${claudeSessionId.slice(0, 8)}`;

    return {
        path: cwd,
        host: os.hostname(),
        version: packageJson.version,
        os: os.platform(),
        machineId: settings.machineId,
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: resolvePath(projectPath(), 'tools', 'unpacked'),
        startedBy: 'terminal',
        startedFromDaemon: false,
        // Keep as 'running': the mobile app locks input on archived sessions
        // with no clear path to resume. `active=false` (set via
        // api.deactivateSession after backfill) is enough to signal "no live
        // process" while keeping the session resumable from the UI.
        lifecycleState: 'running',
        lifecycleStateSince: Date.now(),
        flavor: 'claude',
        // The crucial link: tells `buildResumeLaunch` (in resume/handleResumeCommand.ts:67)
        // which Claude UUID to pass as --resume when the user wants to
        // continue this session.
        claudeSessionId,
        summary: {
            text: title,
            updatedAt: Date.now(),
        },
        name: title,
    };
}
