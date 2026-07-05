import { describe, expect, it, vi } from 'vitest';
import {
  handleKiroCustomNotificationLine,
  mapKiroAvailableCommands,
  mapKiroGoalStatus,
} from './kiroCustomNotifications';

describe('Kiro ACP custom notifications', () => {
  it('normalizes Kiro slash commands for Happy metadata', () => {
    expect(mapKiroAvailableCommands({
      commands: [
        { name: '/goal', description: 'Set a goal' },
        { name: '/model' },
        { name: '' },
      ],
    })).toEqual([
      { name: 'goal', description: 'Set a goal' },
      { name: 'model' },
    ]);
  });

  it('maps active and completed Kiro goal statuses to Happy goal state', () => {
    vi.setSystemTime(new Date('2026-07-05T12:00:00Z'));

    expect(mapKiroGoalStatus({
      state: 'active',
      iteration: 1,
      maxIterations: 5,
      message: 'ship Kiro goal support',
    }, {
      source: 'claude',
      sourceSessionId: 'acp-session-1',
    })).toMatchObject({
      source: 'claude',
      status: 'active',
      sourceSessionId: 'acp-session-1',
      text: 'ship Kiro goal support',
      capabilities: { clear: true, edit: true, stop: true },
      progress: { currentStep: 1, totalSteps: 5 },
    });

    expect(mapKiroGoalStatus({
      state: 'completed',
      message: 'Goal achieved in 0 iterations',
    }, {
      source: 'claude',
      sourceSessionId: 'acp-session-1',
    })).toMatchObject({
      source: 'claude',
      status: 'inactive',
      reason: 'completed',
      sourceSessionId: 'acp-session-1',
    });

    vi.useRealTimers();
  });

  it('handles and filters Kiro-only JSON-RPC notifications', () => {
    const commandLine = JSON.stringify({
      jsonrpc: '2.0',
      method: '_kiro.dev/commands/available',
      params: {
        commands: [{ name: '/goal', description: 'Set a goal' }],
      },
    });

    expect(handleKiroCustomNotificationLine(commandLine, {
      goalStatusSource: 'claude',
      sourceSessionId: 'acp-session-1',
    })).toEqual({
      handled: true,
      messages: [{
        type: 'event',
        name: 'available_commands',
        payload: [{ name: 'goal', description: 'Set a goal' }],
      }],
    });

    expect(handleKiroCustomNotificationLine(JSON.stringify({
      jsonrpc: '2.0',
      method: '_kiro.dev/session/update',
      params: {},
    }), {
      goalStatusSource: 'claude',
      sourceSessionId: 'acp-session-1',
    })).toEqual({
      handled: true,
      messages: [],
    });
  });
});
