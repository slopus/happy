/**
 * Daemon Adopt
 *
 * Given a `happySessionId` not currently tracked by this daemon, look it up
 * in the import journal (~/.happy/imported-sessions.json) and synthesize a
 * `TrackedSession` so the daemon's existing resume pipeline can spawn a child
 * with the correct `--resume <claudeSessionId>` argv and HAPPY_RECONNECT_*
 * env vars.
 *
 * Returns null when the session has never been imported on this machine.
 * The caller should surface the "not tracked" error to the user in that case.
 */

import os from 'node:os';
import { join } from 'node:path';

import { decodeBase64 } from '@/api/encryption';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';

import type { TrackedSession } from '@/daemon/types';

import { findEntryByHappySessionId } from './importJournal';

export async function adoptSessionFromImportJournal(
    happySessionId: string,
): Promise<TrackedSession | null> {
    const entry = await findEntryByHappySessionId(happySessionId);
    if (!entry) return null;

    const encryptionKey = decodeBase64(entry.encryptionKey);
    const encryptionVariant = entry.encryptionVariant;

    // buildResumeLaunch (resume/handleResumeCommand.ts:50-86) only reads
    // `flavor`, `claudeSessionId`, `codexThreadId`, `path` from metadata.
    // Other required-by-type fields are filler that the child process will
    // overwrite when it builds its own metadata in runClaude.ts:111-132.
    const metadata: Metadata = {
        path: entry.cwd,
        host: os.hostname(),
        homeDir: os.homedir(),
        happyHomeDir: configuration.happyHomeDir,
        happyLibDir: projectPath(),
        happyToolsDir: join(projectPath(), 'tools', 'unpacked'),
        flavor: 'claude',
        claudeSessionId: entry.claudeSessionId,
    };

    logger.debug(
        `[ADOPT] Adopted ${happySessionId} from import journal (claudeSessionId=${entry.claudeSessionId})`,
    );

    return {
        startedBy: 'adopted-from-import',
        happySessionId,
        happySessionMetadataFromLocalWebhook: metadata,
        encryption: {
            encryptionKey,
            encryptionVariant,
            // Versions start at 0 — the child process's ApiSessionClient
            // (apiSession.ts:216) updates them on the first server `update`
            // event since `incoming.version > 0` always holds. `seq=0` makes
            // the initial `fetchMessages(after_seq=0)` re-fetch the full
            // server log, which is what we want on a reconnect.
            seq: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
        },
        pid: 0, // No live process — we're about to spawn one.
    };
}
