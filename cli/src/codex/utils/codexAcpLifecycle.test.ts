import { describe, expect, it } from 'vitest';
import { nextCodexLifecycleAcpMessages } from './codexAcpLifecycle';

describe('nextCodexLifecycleAcpMessages', () => {
  it('emits a task_started event and stores the task id', () => {
    const result = nextCodexLifecycleAcpMessages({
      currentTaskId: null,
      msg: { type: 'task_started' },
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ type: 'task_started', id: expect.any(String) });
    expect(result.messages[0].type).toBe('task_started');
    if (result.messages[0].type === 'task_started') {
      expect(result.currentTaskId).toBe(result.messages[0].id);
    }
  });

  it('reuses the current task id across task_started events', () => {
    const result = nextCodexLifecycleAcpMessages({
      currentTaskId: 'task-1',
      msg: { type: 'task_started' },
    });

    expect(result.messages).toEqual([{ type: 'task_started', id: 'task-1' }]);
    expect(result.currentTaskId).toBe('task-1');
  });

  it('emits task_complete and clears the task id', () => {
    const result = nextCodexLifecycleAcpMessages({
      currentTaskId: 'task-1',
      msg: { type: 'task_complete' },
    });

    expect(result.messages).toEqual([{ type: 'task_complete', id: 'task-1' }]);
    expect(result.currentTaskId).toBeNull();
  });

  it('emits turn_aborted and clears the task id', () => {
    const result = nextCodexLifecycleAcpMessages({
      currentTaskId: 'task-1',
      msg: { type: 'turn_aborted' },
    });

    expect(result.messages).toEqual([{ type: 'turn_aborted', id: 'task-1' }]);
    expect(result.currentTaskId).toBeNull();
  });

  it('ignores unrelated events', () => {
    const result = nextCodexLifecycleAcpMessages({
      currentTaskId: 'task-1',
      msg: { type: 'agent_message', message: 'hello' },
    });

    expect(result.messages).toEqual([]);
    expect(result.currentTaskId).toBe('task-1');
  });
});
