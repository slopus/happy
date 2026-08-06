import { describe, expect, it } from 'vitest';
import { applyPersistedTurnStatus, clearStaleRunningTurnStatus } from './sessionTurnStatus';

describe('persisted session turn status', () => {
  it('preserves unrelated encrypted agent state fields', () => {
    const state = {
      requests: {
        permission: { tool: 'Bash', arguments: {}, createdAt: 1 },
      },
    };
    expect(applyPersistedTurnStatus(state, {
      status: 'running',
      updatedAt: 100,
      turnId: 'turn-1',
    })).toEqual({
      ...state,
      turnStatus: { status: 'running', updatedAt: 100, turnId: 'turn-1' },
    });
  });

  it('does not let a late running event overwrite a terminal outcome', () => {
    const terminal = {
      turnStatus: { status: 'failed' as const, updatedAt: 200, turnId: 'turn-1' },
    };
    expect(applyPersistedTurnStatus(terminal, {
      status: 'running',
      updatedAt: 199,
      turnId: 'turn-1',
    })).toBe(terminal);
    expect(applyPersistedTurnStatus(terminal, {
      status: 'running',
      updatedAt: 200,
      turnId: 'turn-1',
    })).toBe(terminal);
  });

  it('keeps the first terminal outcome for a turn despite newer legacy events', () => {
    const cancelled = {
      turnStatus: { status: 'cancelled' as const, updatedAt: 200, turnId: 'turn-1' },
    };
    expect(applyPersistedTurnStatus(cancelled, {
      status: 'completed',
      updatedAt: 201,
      turnId: 'turn-1',
    })).toBe(cancelled);

    const failed = {
      turnStatus: { status: 'failed' as const, updatedAt: 200, turnId: 'turn-1' },
    };
    expect(applyPersistedTurnStatus(failed, {
      status: 'completed',
      updatedAt: 201,
      turnId: 'turn-1',
    })).toBe(failed);

    expect(applyPersistedTurnStatus(failed, {
      status: 'running',
      updatedAt: 202,
      turnId: 'turn-2',
    })).toEqual({
      turnStatus: { status: 'running', updatedAt: 202, turnId: 'turn-2' },
    });
  });

  it('clears only inherited running state on a fresh ready', () => {
    expect(clearStaleRunningTurnStatus({
      controlledByUser: true,
      turnStatus: { status: 'running', updatedAt: 100 },
    })).toEqual({ controlledByUser: true });

    const completed = { turnStatus: { status: 'completed' as const, updatedAt: 101 } };
    expect(clearStaleRunningTurnStatus(completed)).toBe(completed);
  });
});
