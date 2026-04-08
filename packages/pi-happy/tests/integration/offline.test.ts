import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRandomBytes } from 'happy-agent/encryption';

import piHappyExtension from '../../extensions/index';
import {
  STATUS_CONNECTED,
  STATUS_DISCONNECTED,
  STATUS_OFFLINE,
  STATUS_RECONNECTING,
} from '../../extensions/ui';
import { MockHappyServer, waitFor } from '../mock-happy-server';
import {
  createHappyHomeFixture,
  createPiHarness,
  MockDaemonServer,
  setHappyTestEnv,
} from './test-helpers';

describe.sequential('pi-happy integration: offline and reconnect flows', () => {
  const token = 'integration-token';
  const secret = getRandomBytes(32);

  let server: MockHappyServer | null = null;
  let daemonServer: MockDaemonServer | null = null;
  let restoreEnv: (() => void) | null = null;
  let cleanupFixture: (() => Promise<void>) | null = null;

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

  beforeEach(async () => {
    daemonServer = new MockDaemonServer();
    await daemonServer.start();
  });

  it('starts while offline, shows offline status, and recovers once the server becomes available', async () => {
    server = new MockHappyServer({ token, secret, port: 43111 });

    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-offline-startup',
      daemonPort: daemonServer!.httpPort,
    });
    cleanupFixture = fixture.cleanup;
    restoreEnv = setHappyTestEnv(fixture.happyHomeDir, 'http://127.0.0.1:43111');

    const harness = createPiHarness({ cwd: fixture.projectDir });
    piHappyExtension(harness.pi);

    await harness.dispatch('session_start', {});

    await waitFor(() => harness.latestStatus() === STATUS_OFFLINE, 10_000, 20, 'Expected offline status');
    expect(daemonServer!.notifications).toHaveLength(0);

    await server.start();
    await server.waitForCreatedSessions(1, 15_000);

    const session = server.getLastSession();
    await server.waitForSocketConnection(session.id, 15_000);
    await waitFor(() => harness.latestStatus() === STATUS_CONNECTED, 15_000, 20, 'Expected connected status after recovery');
    await waitFor(() => daemonServer!.notifications.length === 1, 15_000, 20, 'Expected daemon notification after recovery');

    expect(daemonServer!.notifications[0]?.sessionId).toBe(session.id);

    await harness.dispatch('session_shutdown', {});
  }, 20_000);

  it('reconnects after a mid-session disconnect and resumes cursor polling with the correct after_seq', async () => {
    server = new MockHappyServer({ token, secret, port: 43112 });
    await server.start();

    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-reconnect',
      daemonPort: daemonServer!.httpPort,
    });
    cleanupFixture = fixture.cleanup;
    restoreEnv = setHappyTestEnv(fixture.happyHomeDir, server.serverUrl);

    const harness = createPiHarness({ cwd: fixture.projectDir });
    piHappyExtension(harness.pi);

    await harness.dispatch('session_start', {});
    await server.waitForCreatedSessions(1);

    const session = server.getLastSession();
    await server.waitForSocketConnection(session.id);
    await waitFor(() => harness.latestStatus() === STATUS_CONNECTED, 10_000, 20, 'Expected initial connected status');

    await harness.dispatch('turn_start', { turnIndex: 0 });
    await waitFor(
      () => server!.getSessionEnvelopes(session.id).length >= 1,
      10_000,
      20,
      'Expected an outbound session envelope before disconnect',
    );

    const lastSeqBeforeDisconnect = server.getSession(session.id).lastSeq;
    expect(lastSeqBeforeDisconnect).toBeGreaterThan(0);

    await server.stop();

    await waitFor(
      () => harness.statusHistory.includes(STATUS_DISCONNECTED) || harness.statusHistory.includes(STATUS_RECONNECTING),
      10_000,
      20,
      'Expected disconnect/reconnect status transition',
    );

    server.queueIncomingUserMessage(session.id, 'Queued while disconnected');
    await server.start();
    await server.waitForSocketConnection(session.id, 15_000);

    await waitFor(
      () => harness.sentUserMessages.some(message => message.content === 'Queued while disconnected'),
      15_000,
      20,
      'Expected queued message to arrive after reconnect',
    );
    await waitFor(() => harness.latestStatus() === STATUS_CONNECTED, 15_000, 20, 'Expected connected status after reconnect');

    expect(server.messagePollRequests.some(request => request.sessionId === session.id && request.afterSeq === lastSeqBeforeDisconnect)).toBe(true);

    await harness.dispatch('session_shutdown', {});
  });
});
