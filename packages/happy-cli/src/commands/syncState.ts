/**
 * Shared sync state types and utilities for attach/sync commands.
 *
 * The sync state file is persisted to disk after `happy attach` and read
 * by `happy sync` (the Stop hook handler) for incremental message sync.
 *
 * @module commands/syncState
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { configuration } from '@/configuration';

/** Sync state persisted to disk for incremental sync after attach */
export interface SyncState {
    happySessionId: string;
    claudeSessionId: string;
    lastSyncedLine: number;
    encryptionKey: string;
    encryptionVariant: 'dataKey' | 'legacy';
    metadataPath: string;
    sessionTag: string;
    createdAt: string;
}

/**
 * Build the path to the sync state file for a given Claude session.
 */
export function syncStatePath(claudeSessionId: string): string {
    return join(configuration.happyHomeDir, 'sync-state', `${claudeSessionId}.json`);
}

/**
 * Read existing sync state from disk, or return null if none exists.
 */
export function readSyncState(claudeSessionId: string): SyncState | null {
    const path = syncStatePath(claudeSessionId);
    if (!existsSync(path)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as SyncState;
    } catch {
        return null;
    }
}

/**
 * Write sync state to disk, creating the directory if necessary.
 * File permissions are restricted to owner-only (0o600) since the
 * state includes the session encryption key.
 */
export function writeSyncState(claudeSessionId: string, state: SyncState): void {
    const dir = join(configuration.happyHomeDir, 'sync-state');
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(syncStatePath(claudeSessionId), JSON.stringify(state, null, 2), { mode: 0o600 });
}
