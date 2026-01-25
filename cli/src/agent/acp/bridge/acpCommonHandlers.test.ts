import { describe, expect, it, vi } from 'vitest';
import { forwardAcpPermissionRequest } from './acpCommonHandlers';

describe('forwardAcpPermissionRequest', () => {
  it('copies toolCall into options.input when input is empty', () => {
    const sendAgentMessage = vi.fn();
    const session = { sendAgentMessage } as any;

    const msg = {
      type: 'permission-request',
      id: 'write_file-1',
      reason: 'write',
      payload: {
        toolName: 'write',
        input: {},
        toolCall: {
          kind: 'edit',
          title: 'Writing to .tmp/happy-tool-ux.txt',
          locations: [{ path: '/tmp/happy-tool-ux.txt' }],
          content: [{ type: 'diff', path: 'happy-tool-ux.txt', oldText: 'a', newText: 'b' }],
          status: 'pending',
          toolCallId: 'write_file-1',
        },
      },
    } as any;

    forwardAcpPermissionRequest({ msg, session, agent: 'gemini' as any });

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendAgentMessage.mock.calls[0];
    expect(message).toMatchObject({
      type: 'permission-request',
      permissionId: 'write_file-1',
      toolName: 'write',
      options: {
        input: {
          kind: 'edit',
          toolCallId: 'write_file-1',
        },
      },
    });
  });

  it('copies toolCall into options.options.input when nested input is empty', () => {
    const sendAgentMessage = vi.fn();
    const session = { sendAgentMessage } as any;

    const msg = {
      type: 'permission-request',
      id: 'edit_file-1',
      reason: 'edit',
      payload: {
        toolName: 'edit',
        options: {
          input: {},
          toolCall: {
            kind: 'edit',
            title: '.tmp/happy-tool-ux.txt: b => beta',
            rawInput: {
              path: '/tmp/happy-tool-ux.txt',
              oldText: 'b',
              newText: 'beta',
            },
          },
        },
      },
    } as any;

    forwardAcpPermissionRequest({ msg, session, agent: 'gemini' as any });

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendAgentMessage.mock.calls[0];
    expect(message).toMatchObject({
      type: 'permission-request',
      permissionId: 'edit_file-1',
      toolName: 'edit',
      options: {
        options: {
          input: {
            path: '/tmp/happy-tool-ux.txt',
          },
        },
      },
    });
  });

  it('preserves non-empty input', () => {
    const sendAgentMessage = vi.fn();
    const session = { sendAgentMessage } as any;

    const msg = {
      type: 'permission-request',
      id: 'read_file-1',
      reason: 'read',
      payload: {
        toolName: 'read',
        input: { locations: [{ path: '/tmp/x' }] },
        toolCall: { kind: 'read', title: 'ignored' },
      },
    } as any;

    forwardAcpPermissionRequest({ msg, session, agent: 'gemini' as any });

    const [, message] = sendAgentMessage.mock.calls[0];
    expect((message as any).options.input).toEqual({ locations: [{ path: '/tmp/x' }] });
  });
});
