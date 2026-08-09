import type { AgentState } from './types';
import type { ApiSessionClient } from './apiSession';

export type PersistedTurnStatus = NonNullable<AgentState['turnStatus']>;

const STATUS_PRECEDENCE: Record<PersistedTurnStatus['status'], number> = {
  running: 0,
  cancelled: 1,
  completed: 2,
  failed: 3,
};

/** Apply a lifecycle outcome without allowing late or duplicate events to regress it. */
export function applyPersistedTurnStatus(
  state: AgentState,
  next: PersistedTurnStatus,
): AgentState {
  const current = state.turnStatus;
  if (current) {
    if (
      current.turnId
      && next.turnId
      && current.turnId === next.turnId
      && current.status !== 'running'
    ) {
      return state;
    }
    if (current.updatedAt > next.updatedAt) {
      return state;
    }
    if (
      current.updatedAt === next.updatedAt
      && STATUS_PRECEDENCE[current.status] > STATUS_PRECEDENCE[next.status]
    ) {
      return state;
    }
    if (
      current.updatedAt === next.updatedAt
      && current.status === next.status
      && current.turnId === next.turnId
    ) {
      return state;
    }
  }

  return { ...state, turnStatus: next };
}

/** A newly started CLI is authoritative that an inherited running flag is stale. */
export function clearStaleRunningTurnStatus(state: AgentState): AgentState {
  if (state.turnStatus?.status !== 'running') {
    return state;
  }
  const { turnStatus: _turnStatus, ...rest } = state;
  return rest;
}

export function applyQueuedMessageCount(state: AgentState, count: number): AgentState {
  const queuedMessages = Math.max(0, Math.floor(count));
  if (queuedMessages === 0) {
    if (state.queuedMessages === undefined) {
      return state;
    }
    const { queuedMessages: _queuedMessages, ...rest } = state;
    return rest;
  }
  if (state.queuedMessages === queuedMessages) {
    return state;
  }
  return { ...state, queuedMessages };
}

export function updateQueuedMessageCount(
  session: Pick<ApiSessionClient, 'updateAgentState'>,
  count: number,
): Promise<void> {
  return session.updateAgentState((state) => applyQueuedMessageCount(state, count));
}
