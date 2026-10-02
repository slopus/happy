import type { ApiSessionClient } from '@/api/apiSession';
import { updateQueuedMessageCount } from '@/api/sessionTurnStatus';

/** A dequeued message is still pending until its root turn has actually started. */
export function createCodexMessageQueueStatus(
    queueSize: () => number,
    session: () => Pick<ApiSessionClient, 'updateAgentState'>,
) {
    let starting = false;
    const sync = () => updateQueuedMessageCount(session(), queueSize() + (starting ? 1 : 0));
    return {
        sync,
        begin() {
            starting = true;
            return sync();
        },
        // Call after publishing turn-start, so the serialized agent-state writes
        // establish running before removing the pending count. Also release in
        // the batch's finally block for failures before a native turn exists.
        release() {
            starting = false;
            return sync();
        },
    };
}
