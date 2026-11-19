import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { CODEX_ACCOUNT_PROVIDER } from './codexAccountConfig';
import { readCodexAccountLaunchState } from './codexAccountLaunchState';
import type { HistoryDatabase } from './codexHistorySchema';

/** Repair only the disposable native index for an authenticated official launch.
 * Native backfill can index a restored rollout as `openai`, while Paws pins the
 * same account to its HTTP-only official provider. Never rewrite the rollout,
 * account history cache, credentials, or routing configuration.
 */
export async function recoverCodexProviderIndex(home: string, profileId: string, threadId: string): Promise<boolean> {
    const state = await readCodexAccountLaunchState(home);
    if (state.profileId !== profileId || state.identityInvalid || state.writeDisabled) return false;
    const root = await realpath(home);
    const path = join(root, 'state_5.sqlite');
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) return false;
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db: HistoryDatabase = new DatabaseSync(path, { timeout: 5_000 });
    try {
        db.exec('BEGIN IMMEDIATE');
        const row = db.prepare('SELECT rollout_path, model_provider FROM threads WHERE id = ?').get(threadId);
        if (row?.model_provider !== 'openai' || typeof row.rollout_path !== 'string') return false;
        const rollout = await realpath(row.rollout_path);
        const rel = relative(root, rollout);
        if (isAbsolute(rel) || !/^(sessions|archived_sessions)[/\\]/.test(rel)) return false;
        const file = await open(rollout, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!(await file.stat()).isFile()) return false;
            const bytes = Buffer.alloc(1024 * 1024);
            const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
            const newline = bytes.subarray(0, bytesRead).indexOf(10);
            if (newline < 0) return false;
            const header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
            if (header.type !== 'session_meta' || header.payload?.id !== threadId
                || !['openai', CODEX_ACCOUNT_PROVIDER].includes(header.payload?.model_provider)) return false;
        } finally { await file.close(); }
        db.prepare('UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ? AND rollout_path = ?')
            .run(CODEX_ACCOUNT_PROVIDER, threadId, 'openai', row.rollout_path);
        db.exec('COMMIT');
        return true;
    } finally {
        try { db.exec('ROLLBACK'); } catch { /* Committed, or no transaction. */ }
        db.close();
    }
}
