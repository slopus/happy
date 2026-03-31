/**
 * Worktree cleanup logic shared by archive and delete flows.
 *
 * When a session lives inside a worktree, this hook decides whether to offer
 * the user the option to delete the worktree:
 *
 * 1. If other active sessions still reference the same worktree → skip silently.
 * 2. If git status has uncommitted changes → skip silently.
 * 3. Otherwise → show a confirmation dialog ("Delete worktree" / "Keep files").
 *
 * The prompt only appears when: no other active sessions AND git is clean.
 */

import { storage } from '@/sync/storage';
import { machineBash } from '@/sync/ops';
import { isWorktreePath, removeWorktree } from '@/utils/worktree';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Check whether any *other* active session shares the same worktree path,
 * then optionally prompt the user to delete the worktree.
 *
 * Returns after the worktree has been removed or the user chose to keep it.
 */
export async function maybeCleanupWorktree(
    sessionId: string,
    sessionPath: string | undefined,
    machineId: string | undefined,
): Promise<void> {
    if (!sessionPath || !machineId || !isWorktreePath(sessionPath)) {
        return;
    }

    // 1. Check if other active sessions use the same worktree
    const allSessions = storage.getState().getActiveSessions();
    const otherOnSameWorktree = allSessions.some(
        s => s.id !== sessionId && s.metadata?.path === sessionPath,
    );
    if (otherOnSameWorktree) {
        return;
    }

    // 2. Check git status for uncommitted changes
    const statusResult = await machineBash(
        machineId,
        'git status --porcelain',
        sessionPath,
    );
    if (!statusResult.success || statusResult.stdout.trim().length > 0) {
        // Either git failed (not a repo / machine offline) or there are changes → skip
        return;
    }

    // 3. Git is clean, no other sessions → ask the user
    const shouldDelete = await Modal.confirm(
        t('sessionInfo.worktreeCleanupTitle'),
        t('sessionInfo.worktreeCleanupMessage'),
        {
            confirmText: t('sessionInfo.worktreeCleanupDelete'),
            cancelText: t('sessionInfo.worktreeCleanupKeep'),
            destructive: true,
        },
    );

    if (shouldDelete) {
        await removeWorktree(machineId, sessionPath).catch(() => {});
    }
}
