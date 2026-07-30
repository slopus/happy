import { selectPendingCommunications } from './agentCommunications';
import { hasBackgroundActivity } from './rig';
import type { AgentState, Metadata } from './storageTypes';

/**
 * `background` means the turn is over but the session still has work in flight
 * — a background shell, a subagent, a workflow. It sits between `thinking` and
 * `waiting`: nothing is being generated, yet the session is not done either.
 */
export type SessionState =
    | 'disconnected'
    | 'thinking'
    | 'background'
    | 'waiting'
    | 'permission_required'
    | 'input_required';

/**
 * One precedence order for every place that presents session state.
 *
 * Permission requests win over questions because they block the tool before it
 * can run. Agent communications come next: once the agent has asked the user a
 * question it is waiting for input even if its provider still reports the turn
 * as thinking.
 */
export function resolveSessionState({
    agentState,
    thinking,
    isOnline,
    metadata,
}: {
    agentState: AgentState | null | undefined;
    thinking: boolean;
    isOnline: boolean;
    metadata?: Metadata | null;
}): SessionState {
    if (!isOnline) return 'disconnected';

    if (agentState?.requests && Object.keys(agentState.requests).length > 0) {
        return 'permission_required';
    }

    if (selectPendingCommunications(agentState ?? null).length > 0) {
        return 'input_required';
    }

    if (thinking) return 'thinking';

    // The turn ended but a background shell / subagent / workflow is still
    // running, so the session is not actually idle.
    if (hasBackgroundActivity(metadata)) return 'background';

    return 'waiting';
}