import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { GeminiPermissionHandler } from './permissionHandler';

type PermissionRpcResponse = {
  id: string;
  approved: boolean;
  decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

describe('GeminiPermissionHandler', () => {
  let agentState: any;
  let permissionRpcHandler: ((response: PermissionRpcResponse) => Promise<void>) | undefined;
  let session: any;
  let pushClient: any;

  beforeEach(() => {
    agentState = {};
    permissionRpcHandler = undefined;

    session = {
      sessionId: 'session-1',
      rpcHandlerManager: {
        registerHandler: vi.fn((name: string, handler: (response: PermissionRpcResponse) => Promise<void>) => {
          if (name === 'permission') {
            permissionRpcHandler = handler;
          }
        }),
      },
      updateAgentState: vi.fn((updater: (state: any) => any) => {
        agentState = updater(agentState);
      }),
    };

    pushClient = {
      sendToAllDevices: vi.fn(),
    };
  });

  it('does not write completedRequests when tool is auto-approved in yolo mode', async () => {
    const handler = new GeminiPermissionHandler(session, pushClient);
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Bash', { command: 'ls -la' });

    expect(result).toEqual({ decision: 'approved_for_session' });
    expect(session.updateAgentState).not.toHaveBeenCalled();
    expect(agentState.completedRequests).toBeUndefined();
  });

  it('manual approval flow still writes request + completedRequest', async () => {
    const handler = new GeminiPermissionHandler(session, pushClient);
    handler.setPermissionMode('default');

    const pending = handler.handleToolCall('tool-2', 'Bash', { command: 'pwd' });

    expect(session.updateAgentState).toHaveBeenCalledTimes(1);
    expect(agentState.requests?.['tool-2']).toMatchObject({
      tool: 'Bash',
      arguments: { command: 'pwd' },
    });

    expect(permissionRpcHandler).toBeDefined();
    await permissionRpcHandler!({ id: 'tool-2', approved: true, decision: 'approved' });

    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(agentState.requests?.['tool-2']).toBeUndefined();
    expect(agentState.completedRequests?.['tool-2']).toMatchObject({
      tool: 'Bash',
      arguments: { command: 'pwd' },
      status: 'approved',
      decision: 'approved',
    });
  });
});
