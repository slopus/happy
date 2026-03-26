import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe.sequential('pi-happy integration: inbound messages', () => {
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

  it('decrypts inbound mobile messages and routes them as follow-up or steering input', async () => {
    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-inbound',
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

    server!.emitIncomingUserMessage(session.id, 'Message from phone');

    await waitFor(
      () => harness.sentUserMessages.some(message => message.content === 'Message from phone' && !message.options),
      10_000,
      20,
      'Expected idle inbound message to trigger a follow-up turn',
    );

    expect(harness.notifications).toContainEqual({
      message: '📱 Message from Happy',
      level: 'info',
    });

    harness.sentUserMessages.length = 0;
    (harness.ctx.isIdle as ReturnType<typeof vi.fn>).mockReturnValue(false);

    server!.emitIncomingUserMessage(session.id, 'Steer the current turn');

    await waitFor(
      () => harness.sentUserMessages.some(message => message.content === 'Steer the current turn' && message.options?.deliverAs === 'steer'),
      10_000,
      20,
      'Expected non-idle inbound message to be delivered as steer',
    );

    await harness.dispatch('session_shutdown', {});
  });
});
