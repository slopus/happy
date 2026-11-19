import type { GoalTaskSession } from '@slopus/happy-wire';
import { isArchivedLifecycleState } from '@/utils/sessionLifecycle';

type LifecycleHeader = { updatedAt?: number; metadata?: { lifecycleState?: string } | null };

/** Daemon history also covers sessions outside the client's hydrated catalog.
 * A newer live header can restore a cached archive; newer history wins otherwise. */
export function isProjectConversationArchived(session: Pick<GoalTaskSession, 'updatedAt' | 'lifecycleState'>, live?: LifecycleHeader) {
    const state = session.lifecycleState && (!live?.metadata || (live.updatedAt ?? 0) < session.updatedAt)
        ? session.lifecycleState : live?.metadata ? live.metadata.lifecycleState : session.lifecycleState;
    return isArchivedLifecycleState(state);
}
