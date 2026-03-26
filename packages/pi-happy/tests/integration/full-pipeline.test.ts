import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getRandomBytes } from 'happy-agent/encryption';

import piHappyExtension from '../../extensions/index';
import {
  STATUS_CONNECTED,
  STATUS_NOT_LOGGED_IN,
  STATUS_DISCONNECTED,
} from '../../extensions/ui';
import { MockHappyServer, waitFor } from '../mock-happy-server';
import {
  createHappyHomeFixture,
  createPiHarness,
  MockDaemonServer,
  setHappyTestEnv,
} from './test-helpers';

describe.sequential('pi-happy integration: full pipeline', () => {
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

  it('bridges pi events to Happy envelopes end-to-end and notifies the daemon', async () => {
    const fixture = await createHappyHomeFixture({
      secret,
      token,
      machineId: 'machine-full-pipeline',
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
    await waitFor(() => daemonServer!.notifications.length === 1, 10_000, 20, 'Expected daemon notification');

    expect(session.metadata).toMatchObject({
      machineId: 'machine-full-pipeline',
      flavor: 'pi',
      path: fixture.projectDir,
      startedBy: 'terminal',
      tools: ['read', 'bash'],
      slashCommands: ['help', 'compact'],
      currentModelCode: 'gpt-5',
    });
    expect(daemonServer!.notifications[0]).toMatchObject({
      sessionId: session.id,
      metadata: expect.objectContaining({
        machineId: 'machine-full-pipeline',
        flavor: 'pi',
      }),
    });

    await harness.dispatch('agent_start', {});
    await harness.dispatch('turn_start', { turnIndex: 0 });

    for (const chunk of ['Hello', ' ', 'from', ' ', 'pi']) {
      await harness.dispatch('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: chunk },
      });
    }

    await harness.dispatch('tool_execution_start', {
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'ls -la' },
    });
    await harness.dispatch('tool_execution_end', {
      toolCallId: 'tool-1',
    });

    for (const chunk of ['Done', ' ', 'now'] ) {
      await harness.dispatch('message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: chunk },
      });
    }

    await harness.dispatch('turn_end', {
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done now' }],
      },
      toolResults: [{ toolCallId: 'tool-1' }],
    });
    await harness.dispatch('agent_end', {});

    await waitFor(
      () => server!.getSessionEnvelopes(session.id).length >= 6,
      10_000,
      20,
      'Expected six session protocol envelopes',
    );

    const envelopes = server!.getSessionEnvelopes(session.id);
    expect(envelopes.map(envelope => envelope.ev.t)).toEqual([
      'turn-start',
      'text',
      'tool-call-start',
      'tool-call-end',
      'text',
      'turn-end',
    ]);
    expect(envelopes[1]).toMatchObject({ ev: { t: 'text', text: 'Hello from pi' } });
    expect(envelopes[2]).toMatchObject({
      ev: {
        t: 'tool-call-start',
        name: 'bash',
        args: { command: 'ls -la' },
      },
    });
    expect(envelopes[4]).toMatchObject({ ev: { t: 'text', text: 'Done now' } });
    expect(envelopes[5]).toMatchObject({ ev: { t: 'turn-end', status: 'completed' } });

    await waitFor(
      () => server!.getSession(session.id).sessionAliveEvents.length >= 1,
      10_000,
      20,
      'Expected keepalive event',
    );

    await harness.dispatch('session_shutdown', {});

    await waitFor(
      () => server!.getSession(session.id).sessionEndEvents.length === 1,
      10_000,
      20,
      'Expected session-end event',
    );
    await waitFor(
      () => server!.getSession(session.id).metadata.lifecycleState === 'archived',
      10_000,
      20,
      'Expected archived lifecycle state',
    );

    expect(server!.getSession(session.id).metadata.lifecycleState).toBe('archived');
    expect(harness.latestStatus()).toBe(STATUS_DISCONNECTED);
  });

  it('degrades gracefully when Happy credentials are missing', async () => {
    const fixture = await createHappyHomeFixture({
      secret,
      token,
      daemonPort: daemonServer!.httpPort,
      withCredentials: false,
    });
    cleanupFixture = fixture.cleanup;
    restoreEnv = setHappyTestEnv(fixture.happyHomeDir, server!.serverUrl);

    const harness = createPiHarness({ cwd: fixture.projectDir });
    piHappyExtension(harness.pi);

    await harness.dispatch('session_start', {});

    expect(harness.latestStatus()).toBe(STATUS_NOT_LOGGED_IN);
    expect(server!.createdSessions).toHaveLength(0);
    expect(daemonServer!.notifications).toHaveLength(0);
  });
});
