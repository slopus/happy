import { describe, expect, it } from 'vitest';

import {
  getConnectionStatusLabel,
  inferTurnEndStatus,
  PI_HAPPY_CONNECTED_STATUS,
  PI_HAPPY_CONNECTING_STATUS,
  PI_HAPPY_DISCONNECTED_STATUS,
  PI_HAPPY_OFFLINE_STATUS,
} from '../index';
import { ConnectionState } from '../types';

describe('pi-happy index helpers', () => {
  it('exposes stable connection status labels', () => {
    expect(getConnectionStatusLabel(ConnectionState.Disconnected)).toBe(PI_HAPPY_DISCONNECTED_STATUS);
    expect(getConnectionStatusLabel(ConnectionState.Connecting)).toBe(PI_HAPPY_CONNECTING_STATUS);
    expect(getConnectionStatusLabel(ConnectionState.Connected)).toBe(PI_HAPPY_CONNECTED_STATUS);
    expect(getConnectionStatusLabel(ConnectionState.Offline)).toBe(PI_HAPPY_OFFLINE_STATUS);
  });

  it('marks aborted turns as cancelled', () => {
    expect(inferTurnEndStatus({
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        content: [],
      },
      toolResults: [],
    }, {
      isIdle: () => true,
    })).toBe('cancelled');
  });

  it('defaults non-aborted turns to completed', () => {
    expect(inferTurnEndStatus({
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'done' }],
      },
      toolResults: [{ toolCallId: 'tool-1' }],
    }, {
      isIdle: () => true,
    })).toBe('completed');
  });
});
