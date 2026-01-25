import { describe, expect, it } from 'vitest';

import type { Machine } from '@/api/types';
import { encodeBase64, encrypt } from '@/api/encryption';

import { ApiMachineClient } from './apiMachine';

describe('ApiMachineClient spawn-happy-session handler', () => {
  it('forwards terminal spawn options to daemon spawnSession handler', async () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);

    let captured: any = null;
    client.setRPCHandlers({
      spawnSession: async (options) => {
        captured = options;
        return { type: 'success', sessionId: 'session-1' };
      },
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const params = {
      directory: '/tmp',
      terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:spawn-happy-session`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      }),
    );
  });

  it('forwards resume-session vendor resume id to daemon spawnSession handler', async () => {
    const machine: Machine = {
      id: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      encryptionVariant: 'legacy',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const client = new ApiMachineClient('token', machine);

    let captured: any = null;
    client.setRPCHandlers({
      spawnSession: async (options) => {
        captured = options;
        return { type: 'success', sessionId: 'session-1' };
      },
      stopSession: async () => true,
      requestShutdown: () => {},
    });

    const rpc = (client as any).rpcHandlerManager;
    const sessionKeyBase64 = encodeBase64(new Uint8Array(32).fill(3), 'base64');
    const params = {
      type: 'resume-session',
      sessionId: 'happy-session-1',
      directory: '/tmp',
      agent: 'codex',
      resume: 'codex-session-123',
      sessionEncryptionKeyBase64: sessionKeyBase64,
      sessionEncryptionVariant: 'dataKey',
      experimentalCodexResume: true,
    };
    const encrypted = encodeBase64(encrypt(machine.encryptionKey, machine.encryptionVariant, params));

    await rpc.handleRequest({
      method: `${machine.id}:spawn-happy-session`,
      params: encrypted,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        directory: '/tmp',
        agent: 'codex',
        existingSessionId: 'happy-session-1',
        resume: 'codex-session-123',
        sessionEncryptionKeyBase64: sessionKeyBase64,
        sessionEncryptionVariant: 'dataKey',
        experimentalCodexResume: true,
      }),
    );
  });
});
