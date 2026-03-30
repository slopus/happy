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

describe.sequential('pi-happy integration: session switching', () => {
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

  it('archives the old Happy session, creates a new one, and notifies the daemon twice', async () => {
    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-session-switch',
      daemonPort: daemonServer!.httpPort,
    });
    cleanupFixture = fixture.cleanup;
    restoreEnv = setHappyTestEnv(fixture.happyHomeDir, server!.serverUrl);

    const harness = createPiHarness({ cwd: fixture.projectDir });
    piHappyExtension(harness.pi);

    await harness.dispatch('session_start', {});
    await server!.waitForCreatedSessions(1);
    const firstSession = server!.getLastSession();
    await server!.waitForSocketConnection(firstSession.id);
    await waitFor(() => harness.latestStatus() === STATUS_CONNECTED, 10_000, 20, 'Expected connected status for first session');

    await harness.dispatch('session_switch', {});

    await server!.waitForCreatedSessions(2);
    const secondSession = server!.getLastSession();
    await server!.waitForSocketConnection(secondSession.id);
    await waitFor(() => daemonServer!.notifications.length === 2, 10_000, 20, 'Expected two daemon notifications');

    expect(firstSession.id).not.toBe(secondSession.id);
    expect(firstSession.metadata.lifecycleState).toBe('archived');
    expect(firstSession.sessionEndEvents).toHaveLength(1);
    expect(daemonServer!.notifications.map(notification => notification.sessionId)).toEqual([
      firstSession.id,
      secondSession.id,
    ]);

    await harness.dispatch('turn_start', { turnIndex: 1 });
    await waitFor(
      () => server!.getSessionEnvelopes(secondSession.id).length >= 1,
      10_000,
      20,
      'Expected outbound traffic on the new session',
    );
    expect(server!.getSessionEnvelopes(secondSession.id)[0]).toMatchObject({
      ev: { t: 'turn-start' },
    });

    await harness.dispatch('session_shutdown', {});
  });
});
