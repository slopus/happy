/**
 * Unarchive Imported Sessions
 *
 * Earlier versions of the importer wrote `lifecycleState: 'archived'` into
 * imported sessions' metadata. The mobile app locks input on archived
 * sessions and offers no way to trigger Resume from there, so the imported
 * sessions were unusable.
 *
 * This module walks every entry in the import journal, decrypts the session
 * key from the journal, opens an ephemeral ApiSessionClient, and clears the
 * archive flags from the session metadata — flipping it back to `running`
 * with `active=false` so the user can hit Resume from the app.
 *
 * Idempotent: sessions already in `running` state still get touched (cheap;
 * the server short-circuits via metadataVersion).
 */

import { ApiClient } from '@/api/api';
import { decodeBase64 } from '@/api/encryption';
import type { Session } from '@/api/types';
import { logger } from '@/ui/logger';

import { readImportJournal } from './importJournal';

export type UnarchiveResult = {
    happySessionId: string;
    claudeSessionId: string;
    status: 'cleared' | 'failed';
    error?: string;
};

export async function unarchiveAllImported(api: ApiClient): Promise<UnarchiveResult[]> {
    const journal = await readImportJournal();
    const results: UnarchiveResult[] = [];

    for (const entry of Object.values(journal.imported)) {
        try {
            // Reconstruct a Session shape good enough for ApiSessionClient.
            // `seq`/`metadataVersion`/`agentStateVersion` start at 0; the
            // first server `update-session` event will refresh them, and the
            // metadata-update RPC handles version mismatches via backoff
            // (apiSession.ts:691-710).
            const synthSession: Session = {
                id: entry.happySessionId,
                seq: 0,
                encryptionKey: decodeBase64(entry.encryptionKey),
                encryptionVariant: entry.encryptionVariant,
                metadata: {
                    path: entry.cwd,
                    host: '',
                    homeDir: '',
                    happyHomeDir: '',
                    happyLibDir: '',
                    happyToolsDir: '',
                    flavor: 'claude',
                    claudeSessionId: entry.claudeSessionId,
                },
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            };

            const client = api.sessionSyncClient(synthSession);

            client.updateMetadata((current) => ({
                ...current,
                lifecycleState: 'running',
                lifecycleStateSince: Date.now(),
                archivedBy: undefined,
                archiveReason: undefined,
            }));

            // Ensure update lands before we close.
            await client.flush();
            await client.close().catch(() => { });

            // Mark inactive — keeps the resume affordance in the UI.
            await api.deactivateSession(entry.happySessionId).catch(() => false);

            results.push({
                happySessionId: entry.happySessionId,
                claudeSessionId: entry.claudeSessionId,
                status: 'cleared',
            });
        } catch (error: any) {
            logger.debug(`[unarchive] failed for ${entry.happySessionId}: ${error?.message}`);
            results.push({
                happySessionId: entry.happySessionId,
                claudeSessionId: entry.claudeSessionId,
                status: 'failed',
                error: error?.message ?? String(error),
            });
        }
    }

    return results;
}
