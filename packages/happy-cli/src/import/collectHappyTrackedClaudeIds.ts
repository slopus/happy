/**
 * Collect Happy-Tracked Claude Session IDs
 *
 * For dedup: build the set of `claudeSessionId` values that already correspond
 * to a happy Session row on the server (so we don't import duplicates).
 *
 * The naive approach — reading `~/.happy/sessions.json` and grabbing
 * `metadata.claudeSessionId` from each entry — doesn't work, because the
 * metadata snapshot stored locally is from the moment the daemon FIRST learned
 * about the session (via webhook), which is BEFORE the SessionStart hook
 * populates claudeSessionId. The fully-updated metadata only lives on the
 * server.
 *
 * Strategy:
 *   1. Read sessions.json → list of (happySessionId, encryptionKey, variant)
 *   2. One `GET /v1/sessions` to pull every server session for this user
 *   3. Per-session: decrypt the metadata using the *locally stored* key
 *      (works without agent.key because we own the key from the moment we
 *      created the session)
 *   4. Collect claudeSessionId values into a Set
 *
 * Failure mode is silent — empty set returned. Worst case the user imports a
 * duplicate, which they can de-dup by hand.
 */

import axios from 'axios';

import { decrypt, decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { readCredentials, readPersistedSessions, type PersistedSession } from '@/persistence';
import { logger } from '@/ui/logger';

type ServerSessionRow = {
    id: string;
    metadata: string; // base64
};

export async function collectHappyTrackedClaudeSessionIds(): Promise<Set<string>> {
    const ids = new Set<string>();

    const persisted = safeReadPersistedSessions();
    if (Object.keys(persisted).length === 0) {
        return ids;
    }

    const credentials = await readCredentials();
    if (!credentials) {
        // No credentials means happy was never authed on this machine, so
        // there are no happy sessions at all. Defensive — shouldn't happen
        // in the normal import flow.
        return ids;
    }

    let serverSessions: ServerSessionRow[];
    try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
            },
            timeout: 30_000,
        });
        serverSessions = (response.data as { sessions: ServerSessionRow[] }).sessions || [];
    } catch (error: any) {
        logger.debug(`[import] failed to fetch sessions from server for dedup: ${error?.message}`);
        return ids;
    }

    const serverById = new Map<string, ServerSessionRow>();
    for (const session of serverSessions) {
        serverById.set(session.id, session);
    }

    for (const [happyId, persistedSession] of Object.entries(persisted)) {
        const claudeId = extractClaudeSessionId(happyId, persistedSession, serverById);
        if (claudeId) ids.add(claudeId);
    }

    return ids;
}

function extractClaudeSessionId(
    happyId: string,
    persisted: PersistedSession,
    serverById: Map<string, ServerSessionRow>,
): string | null {
    // First chance: the locally-snapshotted metadata. Usually empty for
    // claudeSessionId (set after hook fires, post-webhook) but cheap to check.
    const localClaudeId = persisted.metadata?.claudeSessionId;
    if (typeof localClaudeId === 'string' && localClaudeId.length > 0) {
        return localClaudeId;
    }

    // Otherwise, decrypt the latest server metadata using the key we stored
    // when this session was first reported to the daemon.
    const serverRow = serverById.get(happyId);
    if (!serverRow) return null;

    try {
        const key = decodeBase64(persisted.encryptionKey);
        const decrypted = decrypt(key, persisted.encryptionVariant, decodeBase64(serverRow.metadata));
        const candidate = decrypted?.claudeSessionId;
        return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
    } catch (error: any) {
        logger.debug(`[import] could not decrypt server metadata for ${happyId}: ${error?.message}`);
        return null;
    }
}

function safeReadPersistedSessions(): Record<string, PersistedSession> {
    try {
        return readPersistedSessions();
    } catch (error: any) {
        logger.debug(`[import] could not read persisted sessions: ${error?.message}`);
        return {};
    }
}
