import { realpath } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRandomBytes } from 'happy-agent/encryption';

import piHappyExtension from '../../extensions/index';
import { STATUS_CONNECTED } from '../../extensions/ui';
import { MockHappyServer, waitFor } from '../mock-happy-server';
import {
  createHappyHomeFixture,
  createPiHarness,
  MockDaemonServer,
  setHappyTestEnv,
} from './test-helpers';

describe.sequential('pi-happy integration: rpc handlers', () => {
  const token = 'integration-token';
  const secret = getRandomBytes(32);

  let server: MockHappyServer | null = null;
  let daemonServer: MockDaemonServer | null = null;
  let restoreEnv: (() => void) | null = null;
  let cleanupFixture: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    daemonServer = new MockDaemonServer();
    await daemonServer.start();

    server = new MockHappyServer({ token, secret });
    await server.start();
  });

  afterEach(async () => {
    restoreEnv?.();
    restoreEnv = null;

    if (server) {
      await server.stop();
      server = null;
    }

    if (daemonServer) {
      await daemonServer.stop();
      daemonServer = null;
    }

    if (cleanupFixture) {
      await cleanupFixture();
      cleanupFixture = null;
    }
  });

  it('executes session-scoped RPC handlers, including bash, killSession, and abort', async () => {
    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-rpc',
      daemonPort: daemonServer!.httpPort,
    });
    cleanupFixture = fixture.cleanup;
    restoreEnv = setHappyTestEnv(fixture.happyHomeDir, server!.serverUrl);

    const harness = createPiHarness({ cwd: fixture.projectDir });
    piHappyExtension(harness.pi);

    await harness.dispatch('session_start', {});
    await server!.waitForCreatedSessions(1);

    const session = server!.getLastSession();
    await server!.waitForSocketConnection(session.id);
    await waitFor(() => harness.latestStatus() === STATUS_CONNECTED, 10_000, 20, 'Expected connected status');

    await server!.waitForRpcRegistration(session.id, 'bash');
    await server!.waitForRpcRegistration(session.id, 'killSession');
    await server!.waitForRpcRegistration(session.id, 'abort');

    const bashResult = await server!.callRpc(session.id, 'bash', {
      command: 'pwd',
      cwd: fixture.projectDir,
      timeout: 5_000,
    });
    expect(bashResult).toMatchObject({
      success: true,
      exitCode: 0,
    });
    expect(String((bashResult as { stdout?: string }).stdout ?? '').trim()).toBe(await realpath(fixture.projectDir));

    const abortResult = await server!.callRpc(session.id, 'abort', {});
    expect(abortResult).toEqual({ success: true });
    expect(harness.ctx.abort).toHaveBeenCalledTimes(1);

    const killResult = await server!.callRpc(session.id, 'killSession', {});
    expect(killResult).toEqual({ success: true });
    expect(harness.ctx.shutdown).toHaveBeenCalledTimes(1);

    await harness.dispatch('session_shutdown', {});
  });
});
