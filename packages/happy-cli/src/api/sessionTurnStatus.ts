import type { AgentState } from './types';

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
