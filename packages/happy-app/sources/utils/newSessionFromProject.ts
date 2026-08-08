import type { SessionRowData } from '@/sync/storage';
import { useNewSessionDraft } from '@/hooks/useNewSessionDraft';
import { formatPathRelativeToHome } from '@/utils/sessionUtils';
import { getRepoPath, isWorktreePath } from '@/utils/worktree';

/**
 * Points the new-session draft at the project an existing session runs in, so
 * "start another session here" needs no machine or path picking.
 *
 * A worktree session seeds the repository it belongs to plus the worktree, not
 * the worktree path as a plain directory — otherwise the new session would be
 * created as if the worktree were an unrelated project.
 *
 * Order matters: setMachineId clears the path (switching machines must not keep
 * a directory from the previous one), so the path is set after it.
 */
export function seedNewSessionDraftFrom(session: SessionRowData): void {
    const draft = useNewSessionDraft.getState();
    const sessionPath = session.path || '';
    const isWorktree = isWorktreePath(sessionPath);
    const repoPath = isWorktree ? getRepoPath(sessionPath) : sessionPath;

    if (session.machineId) {
        draft.setMachineId(session.machineId);
    }
    draft.setPath(formatPathRelativeToHome(repoPath, session.homeDir ?? undefined));
    draft.setSessionType(isWorktree ? 'worktree' : 'simple');
    draft.setWorktreeKey(isWorktree ? sessionPath : null);
}
